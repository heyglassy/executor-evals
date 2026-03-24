import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpencodeClient, type Config } from "@opencode-ai/sdk";
import type { Event, Part } from "@opencode-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const projectRoot = join(__dirname, "..", "..");

const pingPort = Number(process.env.EVAL_PORT ?? "43123");
const providerID = "opencode";
const modelID = process.env.OPENCODE_MODEL_ID ?? "mimo-v2-pro-free";
const model = `${providerID}/${modelID}`;
const defaultTimeoutMs = 120_000;
const defaultTurnLimit = 25;
const defaultCaseDelayMs = Number(process.env.EVAL_CASE_DELAY_MS ?? "5000");

export const standardExecutorSystem = [
  "You are being evaluated.",
  "Use the executor MCP tools instead of web search.",
  "When asked about available tools, inspect them through executor_execute and answer from that inspection only.",
  "Do not claim that a tool exists unless you actually inspected it.",
].join(" ");

export type EvalTurn = {
  text: string;
  system?: string;
};

export type EvalCase = {
  id: string;
  title: string;
  description: string;
  turns: EvalTurn[];
  system?: string;
  timeoutMs?: number;
  turnLimit?: number;
  expect: {
    requiresPing?: boolean;
    requiredTools?: string[];
    requiredPatternGroups?: string[][];
  };
};

type ToolCallRecord = {
  partID: string;
  messageID: string;
  tool: string;
  status: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

type SessionMessageRecord = {
  info: {
    id: string;
    role?: string;
    [key: string]: unknown;
  };
  parts: Part[];
};

type EvalCaseResult = {
  id: string;
  title: string;
  ok: boolean;
  reason: string;
  artifactDir: string;
  durationMs: number;
  stepCount: number;
  pingCount: number;
  toolsUsed: string[];
  matchedPatterns: string[];
  sessionID?: string;
};

type SuiteSummary = {
  ok: boolean;
  artifactRoot: string;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
};

function localBin(name: string) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(projectRoot, "node_modules", ".bin", `${name}${suffix}`);
}

function getApiKey() {
  const apiKey = process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY.");
  }

  return apiKey;
}

function prettyError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function expectData<T>(
  result: { data: T | undefined; error: unknown },
  label: string,
) {
  if (result.error) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }

  if (result.data === undefined) {
    throw new Error(`${label} returned no data.`);
  }

  return result.data;
}

function expectOk(result: { error: unknown }, label: string) {
  if (result.error) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string) {
  await writeFile(path, value, "utf8");
}

async function resetDir(path: string) {
  await rm(path, { force: true, recursive: true });
  await mkdir(path, { recursive: true });
}

async function runCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd: projectRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.once("error", reject);
      child.once("exit", (exitCode) => {
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
        });
      });
    },
  );
}

async function preflightExecutorTools(executorHome: string) {
  const executorEnv = {
    ...process.env,
    EXECUTOR_HOME: executorHome,
  };

  const helpResult = await runCommand(localBin("executor"), [], executorEnv);

  if (helpResult.exitCode !== 0) {
    throw new Error(
      [
        "Executor preflight command failed.",
        helpResult.stderr.trim(),
        helpResult.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (!helpResult.stdout.includes("eval.test")) {
    throw new Error(
      `Executor preflight output did not include eval.test.\n${helpResult.stdout}`,
    );
  }

  const namespacesResult = await runCommand(
    localBin("executor"),
    ["call", "return await tools.catalog.namespaces({ limit: 50 });", "--no-open"],
    executorEnv,
  );

  if (namespacesResult.exitCode !== 0) {
    throw new Error(
      [
        "Executor namespace listing failed.",
        namespacesResult.stderr.trim(),
        namespacesResult.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const namespaces = JSON.parse(namespacesResult.stdout.trim()) as {
    namespaces: Array<{ namespace: string; toolCount?: number }>;
  };

  if (!namespaces.namespaces.some((entry) => entry.namespace === "eval.test")) {
    throw new Error(
      `Executor namespace listing did not include eval.test.\n${namespacesResult.stdout}`,
    );
  }

  return {
    helpOutput: helpResult.stdout,
    namespaceOutput: namespacesResult.stdout,
    namespaces,
  };
}

async function startPingServer(port: number) {
  let pingCount = 0;
  let firstPayload: unknown;
  let pingResolve: (() => void) | undefined;

  const pingReceived = new Promise<void>((resolve) => {
    pingResolve = resolve;
  });

  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/ping") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      pingCount += 1;

      try {
        firstPayload = body.length > 0 ? JSON.parse(body) : null;
      } catch {
        firstPayload = body;
      }

      pingResolve?.();

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pingCount }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    pingReceived,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    getState: () => ({
      pingCount,
      firstPayload,
    }),
  };
}

async function startOpencodeServer(config: Config, opencodeHome: string) {
  const child = spawn(
    localBin("opencode"),
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        HOME: opencodeHome,
        XDG_CONFIG_HOME: join(opencodeHome, ".config"),
        XDG_DATA_HOME: join(opencodeHome, ".local", "share"),
        XDG_STATE_HOME: join(opencodeHome, ".local", "state"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for OpenCode to start.\n${output}`));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;

      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) {
          continue;
        }

        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          continue;
        }

        clearTimeout(timer);
        resolve(match[1]);
        return;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`OpenCode exited before startup with code ${code}.\n${output}`),
      );
    });
  });

  return {
    url,
    async close() {
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          // Best effort shutdown.
        }
      } else {
        child.kill("SIGTERM");
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (process.platform !== "win32") {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              // Best effort shutdown.
            }
          } else {
            child.kill("SIGKILL");
          }
          resolve();
        }, 2_000);

        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function stopExecutor(executorHome: string) {
  await runCommand(localBin("executor"), ["down"], {
    ...process.env,
    EXECUTOR_HOME: executorHome,
  });
}

function isToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool";
}

function simplifyEvent(event: Event) {
  if (event.type === "message.part.updated") {
    const part = event.properties.part;
    return {
      type: event.type,
      messageID: part.messageID,
      partID: part.id,
      partType: part.type,
      tool: part.type === "tool" ? part.tool : undefined,
      status: part.type === "tool" ? part.state.status : undefined,
    };
  }

  if (event.type === "session.idle") {
    return {
      type: event.type,
      sessionID: event.properties.sessionID,
    };
  }

  if (event.type === "session.error") {
    return {
      type: event.type,
      sessionID: event.properties.sessionID,
      error: event.properties.error,
    };
  }

  return {
    type: event.type,
  };
}

function normalizeToolCall(part: Extract<Part, { type: "tool" }>): ToolCallRecord {
  const state = part.state;

  return {
    partID: part.id,
    messageID: part.messageID,
    tool: part.tool,
    status: state.status,
    input: state.input,
    output: "output" in state ? state.output : undefined,
    error: "error" in state ? state.error : undefined,
    metadata: "metadata" in state ? state.metadata : undefined,
  };
}

function createSessionMonitor(
  events: Awaited<ReturnType<ReturnType<typeof createOpencodeClient>["event"]["subscribe"]>>,
  sessionID: string,
  turnLimit: number,
  streamAbortController: AbortController,
) {
  const stepStartIDs = new Set<string>();
  const toolCalls = new Map<string, ToolCallRecord>();
  const eventLog: unknown[] = [];
  const listeners = new Set<() => void>();

  let idleCount = 0;
  let failure: Error | undefined;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const fail = (error: Error) => {
    if (failure) {
      return;
    }

    failure = error;
    notify();
  };

  const loop = (async () => {
    try {
      for await (const event of events.stream) {
        const payload = event as Event;

        if (payload.type === "message.part.updated") {
          const part = payload.properties.part;
          if (part.sessionID !== sessionID) {
            continue;
          }

          eventLog.push(simplifyEvent(payload));

          if (part.type === "step-start") {
            stepStartIDs.add(part.id);
            if (stepStartIDs.size > turnLimit) {
              fail(
                new Error(`Turn budget exceeded (${stepStartIDs.size} > ${turnLimit}).`),
              );
              return;
            }
          }

          if (isToolPart(part)) {
            toolCalls.set(part.id, normalizeToolCall(part));
          }

          continue;
        }

        if (payload.type === "session.error") {
          if (payload.properties.sessionID === sessionID) {
            eventLog.push(simplifyEvent(payload));
            fail(
              new Error(
                `OpenCode session error: ${JSON.stringify(payload.properties.error)}`,
              ),
            );
            return;
          }

          continue;
        }

        if (payload.type === "session.idle") {
          if (payload.properties.sessionID === sessionID) {
            idleCount += 1;
            eventLog.push(simplifyEvent(payload));
            notify();
          }
        }
      }
    } catch (error) {
      if (!streamAbortController.signal.aborted) {
        fail(new Error(`Event stream failed: ${prettyError(error)}`));
      }
    }
  })();

  return {
    async waitForNextIdle(timeoutMs: number) {
      const targetIdle = idleCount + 1;

      if (failure) {
        throw failure;
      }

      await new Promise<void>((resolve, reject) => {
        const onChange = () => {
          if (failure) {
            cleanup();
            reject(failure);
            return;
          }

          if (idleCount >= targetIdle) {
            cleanup();
            resolve();
          }
        };

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(onChange);
        };

        listeners.add(onChange);
        onChange();
      });
    },
    snapshot() {
      return {
        stepCount: stepStartIDs.size,
        toolCalls: [...toolCalls.values()],
        eventLog,
        failure,
      };
    },
    async stop() {
      streamAbortController.abort();
      await loop.catch(() => undefined);
    },
  };
}

async function getMessages(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
) {
  return expectData(
    await client.session.messages({
      path: { id: sessionID },
      query: { directory: projectRoot },
    }),
    "OpenCode session.messages",
  ) as SessionMessageRecord[];
}

function extractToolCallsFromMessages(messages: SessionMessageRecord[]) {
  const toolCalls = new Map<string, ToolCallRecord>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part)) {
        continue;
      }

      toolCalls.set(part.id, normalizeToolCall(part));
    }
  }

  return [...toolCalls.values()];
}

function renderPart(part: Part) {
  if (part.type === "text") {
    return part.text;
  }

  if (part.type === "reasoning") {
    return `Reasoning:\n${part.text}`;
  }

  if (part.type === "tool") {
    const lines = [`Tool: ${part.tool} (${part.state.status})`];

    lines.push("Input:");
    lines.push("```json");
    lines.push(JSON.stringify(part.state.input, null, 2));
    lines.push("```");

    if ("output" in part.state) {
      lines.push("Output:");
      lines.push("```text");
      lines.push(part.state.output);
      lines.push("```");
    }

    if ("error" in part.state) {
      lines.push("Error:");
      lines.push("```text");
      lines.push(part.state.error);
      lines.push("```");
    }

    return lines.join("\n");
  }

  if (part.type === "step-start") {
    return "[step-start]";
  }

  if (part.type === "step-finish") {
    return `[step-finish] reason=${part.reason} cost=${part.cost}`;
  }

  if (part.type === "patch") {
    return `Patch files: ${part.files.join(", ")}`;
  }

  if (part.type === "agent") {
    return `Agent: ${part.name}`;
  }

  if (part.type === "subtask") {
    return `Subtask: ${part.description}\n${part.prompt}`;
  }

  if (part.type === "file") {
    return `File: ${part.filename ?? part.url}`;
  }

  if (part.type === "retry") {
    return `Retry attempt ${part.attempt}: ${part.error.data.message}`;
  }

  if (part.type === "snapshot") {
    return "[snapshot]";
  }

  if (part.type === "compaction") {
    return `[compaction] auto=${String(part.auto)}`;
  }

  return "[unknown part]";
}

function renderTranscript(messages: SessionMessageRecord[]) {
  return messages
    .map((message) => {
      const role = String(message.info.role ?? "unknown");
      const parts = message.parts.map((part) => renderPart(part)).join("\n\n");
      return `## ${role} ${message.info.id}\n\n${parts}\n`;
    })
    .join("\n");
}

function buildSearchCorpus(
  messages: SessionMessageRecord[],
  toolCalls: ToolCallRecord[],
) {
  const textParts = messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return [part.text];
      }

      if (part.type === "tool") {
        return [
          part.tool,
          JSON.stringify(part.state.input),
          "output" in part.state ? part.state.output : "",
          "error" in part.state ? part.state.error : "",
        ];
      }

      return [];
    }),
  );

  return `${textParts.join("\n")}\n${JSON.stringify(toolCalls, null, 2)}`;
}

function evaluateCase(
  evalCase: EvalCase,
  messages: SessionMessageRecord[],
  toolCalls: ToolCallRecord[],
  pingCount: number,
) {
  const failures: string[] = [];
  const matchedPatterns: string[] = [];
  const toolsUsed = [...new Set(toolCalls.map((toolCall) => toolCall.tool))];
  const corpus = buildSearchCorpus(messages, toolCalls);

  for (const requiredTool of evalCase.expect.requiredTools ?? []) {
    if (!toolsUsed.includes(requiredTool)) {
      failures.push(`Missing required tool call: ${requiredTool}.`);
    }
  }

  for (const group of evalCase.expect.requiredPatternGroups ?? []) {
    const matched = group.find((pattern) => corpus.includes(pattern));

    if (!matched) {
      failures.push(`Missing required pattern group: ${group.join(" | ")}.`);
      continue;
    }

    matchedPatterns.push(matched);
  }

  if (evalCase.expect.requiresPing && pingCount < 1) {
    failures.push("The eval.test tool did not ping the local HTTP server.");
  }

  return {
    ok: failures.length === 0,
    reason:
      failures.length === 0
        ? "All expectations satisfied."
        : failures.join(" "),
    toolsUsed,
    matchedPatterns,
  };
}

async function abortSession(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
) {
  try {
    expectOk(
      await client.session.abort({
        path: { id: sessionID },
        query: { directory: projectRoot },
      }),
      "OpenCode session.abort",
    );
  } catch {
    // Best effort cleanup.
  }
}

async function runEvalCase(evalCase: EvalCase, suiteRoot: string) {
  const startedAt = Date.now();
  const artifactDir = join(suiteRoot, evalCase.id);
  const runtimeRoot = join(artifactDir, "runtime");
  const executorHome = join(runtimeRoot, "executor-home");
  const opencodeHome = join(runtimeRoot, "opencode-home");
  const timeoutMs = evalCase.timeoutMs ?? defaultTimeoutMs;
  const turnLimit = evalCase.turnLimit ?? defaultTurnLimit;

  await mkdir(artifactDir, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeJson(join(artifactDir, "input.json"), evalCase);
  await resetDir(executorHome);
  await resetDir(opencodeHome);

  const pingServer = await startPingServer(pingPort);
  const opencodeConfig: Config = {
    $schema: "https://opencode.ai/config.json",
    logLevel: "ERROR",
    model,
  };

  let opencodeServer: { url: string; close(): Promise<void> } | undefined;
  let monitor:
    | ReturnType<typeof createSessionMonitor>
    | undefined;
  let client:
    | ReturnType<typeof createOpencodeClient>
    | undefined;
  let sessionID: string | undefined;
  let streamAbortController: AbortController | undefined;
  let preflight: unknown = null;
  let messages: SessionMessageRecord[] = [];
  let error: unknown;

  try {
    preflight = await preflightExecutorTools(executorHome);
    await writeJson(join(artifactDir, "preflight.json"), preflight);

    opencodeServer = await startOpencodeServer(opencodeConfig, opencodeHome);
    client = createOpencodeClient({ baseUrl: opencodeServer.url });

    expectOk(
      await client.auth.set({
        path: { id: providerID },
        body: { type: "api", key: getApiKey() },
      }),
      "OpenCode auth.set",
    );

    expectData(
      await client.mcp.add({
        query: { directory: projectRoot },
        body: {
          name: "executor",
          config: {
            type: "local",
            command: [localBin("executor"), "mcp", "--stdio"],
            environment: {
              EXECUTOR_HOME: executorHome,
            },
            enabled: true,
            timeout: 10_000,
          },
        },
      }),
      "OpenCode mcp.add",
    );

    expectOk(
      await client.mcp.connect({
        path: { name: "executor" },
        query: { directory: projectRoot },
      }),
      "OpenCode mcp.connect",
    );

    const session = expectData(
      await client.session.create({
        query: { directory: projectRoot },
        body: { title: evalCase.title },
      }),
      "OpenCode session.create",
    );

    sessionID = session.id;

    streamAbortController = new AbortController();
    const events = await client.event.subscribe({
      query: { directory: projectRoot },
      signal: streamAbortController.signal,
    });
    monitor = createSessionMonitor(
      events,
      session.id,
      turnLimit,
      streamAbortController,
    );

    for (const turn of evalCase.turns) {
      expectOk(
        await client.session.promptAsync({
          path: { id: session.id },
          query: { directory: projectRoot },
          body: {
            model: { providerID, modelID },
            system: turn.system ?? evalCase.system ?? standardExecutorSystem,
            parts: [{ type: "text", text: turn.text }],
          },
        }),
        "OpenCode session.promptAsync",
      );

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = timeoutMs - elapsedMs;

      if (remainingMs <= 0) {
        throw new Error(`Timed out after ${timeoutMs}ms.`);
      }

      await monitor.waitForNextIdle(remainingMs);
    }

    messages = await getMessages(client, session.id);
  } catch (caughtError) {
    error = caughtError;

    if (client && sessionID) {
      try {
        messages = await getMessages(client, sessionID);
      } catch {
        // Best effort artifact capture.
      }

      await abortSession(client, sessionID);
    }
  } finally {
    await monitor?.stop().catch(() => undefined);

    try {
      await pingServer.close();
    } catch {
      // Best effort cleanup.
    }

    if (opencodeServer) {
      await opencodeServer.close().catch(() => undefined);
    }

    await stopExecutor(executorHome).catch(() => undefined);
  }

  const pingState = pingServer.getState();
  const toolCalls =
    messages.length > 0
      ? extractToolCallsFromMessages(messages)
      : monitor?.snapshot().toolCalls ?? [];
  const evaluation = evaluateCase(evalCase, messages, toolCalls, pingState.pingCount);
  const monitorSnapshot = monitor?.snapshot();

  const result: EvalCaseResult = {
    id: evalCase.id,
    title: evalCase.title,
    ok: error ? false : evaluation.ok,
    reason: error ? prettyError(error) : evaluation.reason,
    artifactDir,
    durationMs: Date.now() - startedAt,
    stepCount: monitorSnapshot?.stepCount ?? 0,
    pingCount: pingState.pingCount,
    toolsUsed: evaluation.toolsUsed,
    matchedPatterns: evaluation.matchedPatterns,
    sessionID,
  };

  await writeJson(join(artifactDir, "messages.json"), messages);
  await writeText(join(artifactDir, "transcript.md"), renderTranscript(messages));
  await writeJson(join(artifactDir, "tool-calls.json"), toolCalls);
  await writeJson(join(artifactDir, "events.json"), monitorSnapshot?.eventLog ?? []);
  await writeJson(join(artifactDir, "result.json"), {
    ...result,
    model,
    pingPayload: pingState.firstPayload,
    preflight,
    error: error ? prettyError(error) : null,
  });

  return result;
}

function stampForPath(date: Date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function sleep(milliseconds: number) {
  if (milliseconds <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function runSuite(evalCases: EvalCase[]): Promise<SuiteSummary> {
  const suiteRoot = join(projectRoot, "eval-results", stampForPath(new Date()));
  await mkdir(suiteRoot, { recursive: true });

  const results: EvalCaseResult[] = [];

  for (const [index, evalCase] of evalCases.entries()) {
    console.log(
      `[eval ${index + 1}/${evalCases.length}] start ${evalCase.id}: ${evalCase.title}`,
    );
    const result = await runEvalCase(evalCase, suiteRoot);
    results.push(result);
    console.log(
      `[eval ${index + 1}/${evalCases.length}] ${result.ok ? "pass" : "fail"} ${evalCase.id}: ${result.reason}`,
    );

    if (index < evalCases.length - 1) {
      await sleep(defaultCaseDelayMs);
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const summary: SuiteSummary = {
    ok: failed === 0,
    artifactRoot: suiteRoot,
    passed,
    failed,
    results,
  };

  await writeJson(join(suiteRoot, "summary.json"), summary);

  return summary;
}

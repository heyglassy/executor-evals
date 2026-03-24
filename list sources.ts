import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpencodeClient, type Config } from "@opencode-ai/sdk";
import type { Event, Part } from "@opencode-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const pingPort = Number(process.env.EVAL_PORT ?? "43123");
const timeoutMs = 120_000;
const turnLimit = 25;
const providerID = "opencode";
const modelID = process.env.OPENCODE_MODEL_ID ?? "mimo-v2-pro-free";
const model = `${providerID}/${modelID}`;
const opencodeApiKey =
  process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;

if (!opencodeApiKey) {
  console.error("Missing OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY.");
  process.exit(1);
}

const apiKey = opencodeApiKey;

const runtimeRoot = join(projectRoot, ".runtime");
const executorHome = join(runtimeRoot, "executor-home");
const opencodeHome = join(runtimeRoot, "opencode-home");

const opencodeConfig: Config = {
  $schema: "https://opencode.ai/config.json",
  logLevel: "ERROR",
  model,
};

function localBin(name: string) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(projectRoot, "node_modules", ".bin", `${name}${suffix}`);
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

function expectOk(
  result: { error: unknown },
  label: string,
) {
  if (result.error) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
}

async function resetDir(path: string) {
  await rm(path, { force: true, recursive: true });
  await mkdir(path, { recursive: true });
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
      firstPayload = body.length > 0 ? JSON.parse(body) : null;
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
    url: `http://127.0.0.1:${port}/ping`,
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

async function preflightExecutorTools() {
  const helpResult = await runCommand(
    localBin("executor"),
    [],
    {
      ...process.env,
      EXECUTOR_HOME: executorHome,
    },
  );

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
    {
      ...process.env,
      EXECUTOR_HOME: executorHome,
    },
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

  const hasEvalNamespace = namespaces.namespaces.some(
    (entry) => entry.namespace === "eval.test",
  );

  if (!hasEvalNamespace) {
    throw new Error(
      `Executor namespace listing did not include eval.test.\n${namespacesResult.stdout}`,
    );
  }

  return {
    helpOutput: helpResult.stdout,
    namespaces,
  };
}

async function startOpencodeServer(config: Config) {
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

async function stopExecutor() {
  await runCommand(
    localBin("executor"),
    ["down"],
    {
      ...process.env,
      EXECUTOR_HOME: executorHome,
    },
  );
}

async function main() {
  await mkdir(runtimeRoot, { recursive: true });
  await resetDir(executorHome);
  await resetDir(opencodeHome);

  const pingServer = await startPingServer(pingPort);

  const cleanup = async (serverClose?: () => Promise<void>) => {
    try {
      await pingServer.close();
    } finally {
      if (serverClose) {
        await serverClose();
      }
      await stopExecutor();
    }
  };

  let opencodeServer: { url: string; close(): Promise<void> } | undefined;
  let eventsAbortController: AbortController | undefined;

  try {
    const executorPreflight = await preflightExecutorTools();

    opencodeServer = await startOpencodeServer(opencodeConfig);
    const client = createOpencodeClient({ baseUrl: opencodeServer.url });

    expectOk(
      await client.auth.set({
      path: { id: providerID },
      body: { type: "api", key: apiKey },
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
        body: { title: "Executor MCP eval" },
      }),
      "OpenCode session.create",
    );

    const prompt = [
      "Can you use the execute MCP and see what tools I have available for me to use?",
      "Can you please use the test tool.",
      "Use the executor MCP server to inspect the available tools, then call the test tool and stop once it succeeds.",
    ].join(" ");

    eventsAbortController = new AbortController();
    const events = await client.event.subscribe({
      query: { directory: projectRoot },
      signal: eventsAbortController.signal,
    });

    const stepStartIDs = new Set<string>();
    const toolCalls: string[] = [];

    let pingSeen = false;
    let completed = false;

    const sessionDone = new Promise<{
      success: boolean;
      reason: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      pingServer.pingReceived.then(() => {
        pingSeen = true;
      }).catch(reject);

      const finish = (success: boolean, reason: string) => {
        if (completed) {
          return;
        }

        completed = true;
        clearTimeout(timeout);
        resolve({ success, reason });
      };

      const fail = (reason: string) => {
        if (completed) {
          return;
        }

        completed = true;
        clearTimeout(timeout);
        reject(new Error(reason));
      };

      (async () => {
        try {
          for await (const event of events.stream) {
            const payload = event as Event;

            if (payload.type === "session.error") {
              if (payload.properties.sessionID === session.id) {
                fail(`OpenCode session error: ${JSON.stringify(payload.properties.error)}`);
                return;
              }
            }

            if (payload.type === "session.idle") {
              if (payload.properties.sessionID === session.id) {
                if (pingSeen) {
                  finish(true, "The test tool pinged the local HTTP server.");
                } else {
                  fail("OpenCode went idle without calling the test tool.");
                }
                return;
              }
            }

            if (payload.type !== "message.part.updated") {
              continue;
            }

            const part = payload.properties.part as Part;
            if (part.sessionID !== session.id) {
              continue;
            }

            if (part.type === "step-start") {
              stepStartIDs.add(part.id);
              if (stepStartIDs.size > turnLimit) {
                fail(`Turn budget exceeded (${stepStartIDs.size} > ${turnLimit}).`);
                return;
              }
            }

            if (part.type === "tool") {
              toolCalls.push(part.tool);
            }
          }
        } catch (error) {
          if (!completed && !eventsAbortController?.signal.aborted) {
            fail(`Event stream failed: ${prettyError(error)}`);
          }
        }
      })().catch(reject);
    });

    expectOk(
      await client.session.promptAsync({
        path: { id: session.id },
        query: { directory: projectRoot },
        body: {
          model: { providerID, modelID },
          system:
            "You are being evaluated. Use the executor_execute MCP tool. Inside executor, first confirm that the eval.test tool exists, then call eval.test with __executor_invokeTool(\"eval.test\", { note: \"opencode-eval\" }). Do not stop before eval.test succeeds.",
          parts: [{ type: "text", text: prompt }],
        },
      }),
      "OpenCode session.promptAsync",
    );

    const result = await sessionDone;

    eventsAbortController.abort();

    const pingState = pingServer.getState();

    console.log(
      JSON.stringify(
        {
          ok: result.success,
          model,
          reason: result.reason,
          executorPreflightNamespaces: executorPreflight.namespaces.namespaces,
          stepCount: stepStartIDs.size,
          toolCalls,
          pingCount: pingState.pingCount,
          pingPayload: pingState.firstPayload,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    eventsAbortController?.abort();

    if (opencodeServer) {
      try {
        const client = createOpencodeClient({ baseUrl: opencodeServer.url });
        const sessions = expectData(
          await client.session.list({
            query: { directory: projectRoot },
          }),
          "OpenCode session.list",
        );
        const latest = sessions[0];
        if (latest) {
          expectOk(
            await client.session.abort({
              path: { id: latest.id },
              query: { directory: projectRoot },
            }),
            "OpenCode session.abort",
          );
        }
      } catch {
        // Best effort cleanup.
      }
    }

    console.error(
      JSON.stringify(
        {
          ok: false,
          model,
          error: prettyError(error),
          pingCount: pingServer.getState().pingCount,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    eventsAbortController?.abort();
    await cleanup(opencodeServer?.close.bind(opencodeServer));
  }
}

await main();

import type { EvalCase } from "../shared/harness.js";
import { standardExecutorSystem } from "../shared/harness.js";

export const conversationJustLookAtMcpToolsCase: EvalCase = {
  id: "conversation-just-look-at-mcp-tools",
  title: "Conversation Just Look At MCP Tools",
  description:
    "Replay the follow-up that forces the model to inspect its MCP tools directly.",
  system: [
    standardExecutorSystem,
    "Do not browse docs for this question.",
    "Inspect the executor MCP tools directly and answer from those results.",
  ].join(" "),
  turns: [
    {
      text: "Can you tell me what tools executor-dev has available to it?",
    },
    {
      text: "in the executor-dev mcp",
    },
    {
      text: "just look at your mcp tools",
    },
  ],
  expect: {
    requiredTools: ["executor_execute"],
    requiredPatternGroups: [["catalog.namespaces", "catalog.tools"]],
  },
};

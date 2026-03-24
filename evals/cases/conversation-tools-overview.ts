import type { EvalCase } from "../shared/harness.js";
import { standardExecutorSystem } from "../shared/harness.js";

export const conversationToolsOverviewCase: EvalCase = {
  id: "conversation-tools-overview",
  title: "Conversation Tools Overview",
  description:
    "Replay the initial executor-dev MCP tool availability question and require direct executor inspection.",
  system: [
    standardExecutorSystem,
    "Use executor_execute to inspect the executor-dev MCP tool surface before answering.",
  ].join(" "),
  turns: [
    {
      text: "Can you tell me what tools executor-dev has available to it?",
    },
    {
      text: "in the executor-dev mcp",
    },
  ],
  expect: {
    requiredTools: ["executor_execute"],
    requiredPatternGroups: [["catalog.namespaces", "catalog.tools", "discover("]],
  },
};

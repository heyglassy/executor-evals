import type { EvalCase } from "../shared/harness.js";
import { standardExecutorSystem } from "../shared/harness.js";

export const conversationDescribeToolsToolCase: EvalCase = {
  id: "conversation-describe-tools-tool",
  title: "Conversation Describe Tools Tool",
  description:
    "Ask for the executor-dev MCP tools by specifically using the describe tool workflow.",
  system: [
    standardExecutorSystem,
    "Use executor_execute and the describe.tool workflow to answer this question.",
  ].join(" "),
  turns: [
    {
      text: "what tools does executor-dev have available if you use the describe tools tool",
    },
  ],
  expect: {
    requiredTools: ["executor_execute"],
    requiredPatternGroups: [["describe.tool"]],
  },
};

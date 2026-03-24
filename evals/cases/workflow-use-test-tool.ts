import type { EvalCase } from "../shared/harness.js";
import { standardExecutorSystem } from "../shared/harness.js";

export const workflowUseTestToolCase: EvalCase = {
  id: "workflow-use-test-tool",
  title: "Workflow Use Test Tool",
  description:
    "Run the full workflow: inspect executor tools, confirm eval.test exists, and call the test tool successfully.",
  system: [
    standardExecutorSystem,
    "First confirm that eval.test exists.",
    'Then call eval.test with __executor_invokeTool("eval.test", { note: "opencode-eval" }).',
    "Do not stop before the test tool succeeds.",
  ].join(" "),
  turns: [
    {
      text: [
        "Can you use the execute MCP and see what tools I have available for me to use?",
        "Can you please use the test tool.",
        "Use the executor MCP server to inspect the available tools, then call the test tool and stop once it succeeds.",
      ].join(" "),
    },
  ],
  expect: {
    requiresPing: true,
    requiredTools: ["executor_execute"],
    requiredPatternGroups: [["eval.test"]],
  },
};

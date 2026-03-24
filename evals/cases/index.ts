import { conversationDescribeToolsToolCase } from "./conversation-describe-tools-tool.js";
import { conversationJustLookAtMcpToolsCase } from "./conversation-just-look-at-mcp-tools.js";
import { conversationToolsOverviewCase } from "./conversation-tools-overview.js";
import { workflowUseTestToolCase } from "./workflow-use-test-tool.js";

export const allEvalCases = [
  conversationToolsOverviewCase,
  conversationJustLookAtMcpToolsCase,
  conversationDescribeToolsToolCase,
  workflowUseTestToolCase,
];

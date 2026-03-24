import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const pingUrl = process.env.EVAL_PING_URL;

if (!pingUrl) {
  throw new Error("EVAL_PING_URL is required");
}

const server = new McpServer({
  name: "eval-test-server",
  version: "0.0.0",
});

server.registerTool(
  "test",
  {
    description: "Ping the local eval HTTP server to confirm the tool was executed.",
    inputSchema: {
      note: z.string().optional(),
    },
  },
  async ({ note }) => {
    const response = await fetch(pingUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        note: note ?? null,
        pid: process.pid,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ping failed with status ${response.status}`);
    }

    return {
      content: [
        {
          type: "text",
          text: "The eval test server acknowledged the ping.",
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();

await server.connect(transport);

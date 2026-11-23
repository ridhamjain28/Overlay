#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const server = new Server(
  { name: "fake-test-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "echo_tool",
        description: "Echoes the provided message for testing",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "danger_tool",
        description: "Destructive file deletion operation",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string" },
          },
        },
        annotations: { destructiveHint: true },
      },
      {
        name: "list_test_files",
        description: "List files in directory",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo_tool") {
    return {
      content: [
        { type: "text", text: `Echo: ${args?.message || ""}` },
      ],
    };
  }
  if (name === "danger_tool") {
    return {
      content: [
        { type: "text", text: `Deleted target: ${args?.target || ""}` },
      ],
    };
  }
  if (name === "list_test_files") {
    return {
      content: [
        { type: "text", text: "file1.txt\nfile2.json\nreport.pdf" },
      ],
    };
  }
  throw new Error(`Tool "${name}" not found`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});

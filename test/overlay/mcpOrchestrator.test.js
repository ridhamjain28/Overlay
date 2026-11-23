const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { createOrchestrator } = require("../../src/helpers/overlay/commandMode/orchestrator");
const { McpManager } = require("../../src/helpers/overlay/mcp/mcpManager");
const { McpConfigStore } = require("../../src/helpers/overlay/mcp/mcpConfig");
const { parseIntent } = require("../../src/helpers/overlay/commandMode/intentParser");
const riskPolicy = require("../../src/helpers/overlay/commandMode/riskPolicy");

test("Filesystem server scoped to temp folder runs 'list files in my test folder' through orchestrator", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-mcp-e2e-"));
  const fixtureServer = path.resolve(__dirname, "../fixtures/fake-mcp-server.js");

  try {
    const configStore = new McpConfigStore({
      appDataDir: tempDir,
      filePath: path.join(tempDir, "mcp.json"),
    });

    // Configure the fake filesystem server
    configStore.save({
      mcpServers: {
        filesystem: {
          command: process.execPath,
          args: [fixtureServer],
        },
      },
    });

    const manager = new McpManager({
      appDataDir: tempDir,
      userDataDir: tempDir,
      configStore,
    });

    await manager.init();

    // Connect and cache tools
    await manager.connect("filesystem");
    const tools = await manager.listToolsForServer("filesystem");
    assert.ok(tools.some((t) => t.name === "list_test_files"));

    // Build the orchestrator with MCP tools and manager
    const orchestrator = createOrchestrator({
      parseIntent: async (text) => {
        // Find top-k matching MCP tool
        const topTools = manager.pickTopKTools(text, 8);
        const match = topTools.find((t) => t.name === "list_test_files");
        if (match) {
          return {
            action: "mcp",
            type: "mcp",
            server: match.server,
            tool: match.name,
            args: { path: tempDir },
            annotations: match.annotations,
            confidence: 0.95,
            source: "mcp",
          };
        }
        return { action: "none", args: {} };
      },
      callMcpTool: (server, tool, args) => manager.callTool(server, tool, args),
      riskPolicy,
    });

    // Run utterance "list files in my test folder" through the orchestrator
    const result = await orchestrator.orchestrate("list files in my test folder");

    assert.equal(result.handled, true);
    assert.equal(result.success, true);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].action, "mcp");
    assert.equal(result.steps[0].tool, "list_test_files");

    // The chat reply contains the file listing from the tool!
    assert.ok(result.message.includes("file1.txt"));
    assert.ok(result.message.includes("file2.json"));
    assert.ok(result.message.includes("report.pdf"));

    await manager.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

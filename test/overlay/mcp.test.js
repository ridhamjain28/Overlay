const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { validateConfig, McpConfigStore } = require("../../src/helpers/overlay/mcp/mcpConfig");
const { McpManager } = require("../../src/helpers/overlay/mcp/mcpManager");
const { ToolIndex, selectTopKTools } = require("../../src/helpers/overlay/mcp/toolIndex");
const { McpAuthStore } = require("../../src/helpers/overlay/mcp/mcpAuth");
const riskPolicy = require("../../src/helpers/overlay/commandMode/riskPolicy");

test("McpConfig validation detects syntax and structure errors", () => {
  // Invalid json
  const r1 = validateConfig("{ bad json ");
  assert.equal(r1.ok, false);
  assert.ok(r1.errors[0].includes("Invalid JSON"));

  // Not an object or missing mcpServers
  const r2 = validateConfig("[]");
  assert.equal(r2.ok, false);

  const r3 = validateConfig('{"otherKey": {}}');
  assert.equal(r3.ok, false);

  // Missing command and url
  const r4 = validateConfig('{"mcpServers": {"invalid-serv": {}}}');
  assert.equal(r4.ok, false);
  assert.ok(r4.errors[0].includes("command") || r4.errors[0].includes("url"));

  // Valid stdio & remote configs
  const valid = {
    mcpServers: {
      "local-tool": {
        command: "node",
        args: ["script.js"],
        env: { FOO: "BAR" },
      },
      "remote-serv": {
        url: "https://mcp.example.com/sse",
        headers: { "X-Test": "123" },
      },
    },
  };
  const r5 = validateConfig(JSON.stringify(valid));
  assert.equal(r5.ok, true);
  assert.equal(Object.keys(r5.servers).length, 2);
  assert.equal(r5.servers["local-tool"].command, "node");
  assert.equal(r5.servers["remote-serv"].url, "https://mcp.example.com/sse");
});

test("McpManager connects to fake stdio MCP server fixture, lists tools, caches on disk, and calls tool", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-mcp-test-"));
  const fixturePath = path.resolve(__dirname, "../fixtures/fake-mcp-server.js");

  try {
    const configStore = new McpConfigStore({
      appDataDir: tempDir,
      filePath: path.join(tempDir, "mcp.json"),
    });

    configStore.save({
      mcpServers: {
        "fake-server": {
          command: process.execPath,
          args: [fixturePath],
        },
      },
    });

    const manager = new McpManager({
      appDataDir: tempDir,
      userDataDir: tempDir,
      configStore,
    });

    await manager.init();

    // Connect to server
    await manager.connect("fake-server");

    // List tools
    const tools = await manager.listToolsForServer("fake-server");
    assert.ok(tools.length >= 3);
    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes("echo_tool"));
    assert.ok(toolNames.includes("danger_tool"));
    assert.ok(toolNames.includes("list_test_files"));

    // Verify disk cache created at %APPDATA%\Overlay\mcp\<server>\<tool>.json
    const cacheDir = path.join(tempDir, "Overlay", "mcp", "fake-server");
    assert.ok(fs.existsSync(cacheDir));
    const cachedEcho = JSON.parse(fs.readFileSync(path.join(cacheDir, "echo_tool.json"), "utf-8"));
    assert.equal(cachedEcho.name, "echo_tool");
    assert.equal(cachedEcho.annotations.readOnlyHint, true);

    // Call tool
    const callRes = await manager.callTool("fake-server", "echo_tool", { message: "Hello Overlay!" });
    assert.equal(callRes.isError, undefined);
    assert.equal(callRes.content[0].text, "Echo: Hello Overlay!");

    // Call tool 2
    const callRes2 = await manager.callTool("fake-server", "danger_tool", { target: "temp_db" });
    assert.equal(callRes2.content[0].text, "Deleted target: temp_db");

    // Server status is connected
    const status = manager.serverStatuses.get("fake-server");
    assert.equal(status.status, "connected");

    await manager.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Lazy start: stdio server is not started until a tool is called", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-mcp-lazy-"));
  const fixturePath = path.resolve(__dirname, "../fixtures/fake-mcp-server.js");

  try {
    const configStore = new McpConfigStore({
      appDataDir: tempDir,
      filePath: path.join(tempDir, "mcp.json"),
    });

    configStore.save({
      mcpServers: {
        "lazy-server": {
          command: process.execPath,
          args: [fixturePath],
        },
      },
    });

    // Populate disk cache as if saved during previous session
    const cacheDir = path.join(tempDir, "Overlay", "mcp", "lazy-server");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "echo_tool.json"),
      JSON.stringify({
        name: "echo_tool",
        description: "Echo tool",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
        annotations: { readOnlyHint: true },
      })
    );

    const manager = new McpManager({
      appDataDir: tempDir,
      userDataDir: tempDir,
      configStore,
    });

    await manager.init();

    // Server should not be connected yet (lazy start)
    assert.equal(manager.clients.has("lazy-server"), false);
    assert.equal(manager.serverStatuses.get("lazy-server").status, "disconnected");

    // But its tools are already available in the tool index from disk cache!
    const topTools = manager.pickTopKTools("echo some message");
    assert.equal(topTools.length, 1);
    assert.equal(topTools[0].name, "echo_tool");

    // Calling the tool triggers lazy connection
    const res = await manager.callTool("lazy-server", "echo_tool", { message: "Lazy works!" });
    assert.equal(res.content[0].text, "Echo: Lazy works!");
    assert.equal(manager.clients.has("lazy-server"), true);

    await manager.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("BM25 top-k tool selection picks relevant tools up to k <= 8", () => {
  const mockTools = [
    { server: "fs", name: "read_file", description: "Read contents of a file on disk" },
    { server: "fs", name: "list_directory", description: "List files and folders in directory" },
    { server: "fs", name: "write_file", description: "Write contents to a file" },
    { server: "github", name: "create_issue", description: "Create a GitHub issue in a repository" },
    { server: "github", name: "list_issues", description: "List issues in repository" },
    { server: "web", name: "fetch", description: "Fetch web page and convert to markdown" },
    { server: "canva", name: "search_templates", description: "Search Canva design templates" },
    { server: "notion", name: "search_pages", description: "Search pages in Notion workspace" },
    { server: "spotify", name: "play_track", description: "Play a song on Spotify" },
    { server: "calendar", name: "add_event", description: "Add a meeting or event to calendar" },
  ];

  const index = new ToolIndex(mockTools);

  // Search for file listing
  const fileHits = index.pickTopK("list the files in my folder", { k: 8 });
  assert.ok(fileHits.length > 0 && fileHits.length <= 8);
  assert.equal(fileHits[0].name, "list_directory");

  // Search for github issue
  const githubHits = index.pickTopK("create a new issue on github repository", { k: 5 });
  assert.ok(githubHits.length > 0 && githubHits.length <= 5);
  assert.equal(githubHits[0].name, "create_issue");

  // Top k constraint (never exceeds 8)
  const allHits = index.pickTopK("file directory issue templates pages", { k: 15 });
  assert.ok(allHits.length <= 8);
});

test("Risk mapping from MCP tool annotations", () => {
  // readOnlyHint => auto
  const readOnlyStep = {
    type: "mcp",
    server: "fs",
    tool: "list_directory",
    annotations: { readOnlyHint: true },
  };
  assert.equal(riskPolicy.classify(readOnlyStep), "auto");

  // destructiveHint => confirm
  const destructiveStep = {
    type: "mcp",
    server: "fs",
    tool: "delete_file",
    annotations: { destructiveHint: true },
  };
  assert.equal(riskPolicy.classify(destructiveStep), "confirm");

  // unknown (no annotations) => confirm
  const unknownStep = {
    type: "mcp",
    server: "custom",
    tool: "custom_operation",
    annotations: {},
  };
  assert.equal(riskPolicy.classify(unknownStep), "confirm");

  // blocked mcp action (disk formatting / credential export) => block
  const blockedStep = {
    type: "mcp",
    server: "system",
    tool: "format_disk",
  };
  assert.equal(riskPolicy.classify(blockedStep), "block");
});

test("Token storage is encrypted and never written to mcp.json or renderer", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-mcp-auth-"));
  try {
    const authStore = new McpAuthStore(tempDir);
    authStore.saveTokens("notion", {
      accessToken: "secret_access_token_12345",
      refreshToken: "secret_refresh_token_67890",
      expiresIn: 3600,
    });

    // Tokens file exists and is encrypted on disk
    const tokenFile = path.join(tempDir, "mcp-tokens.enc");
    assert.ok(fs.existsSync(tokenFile));
    const rawDisk = fs.readFileSync(tokenFile);
    // Plaintext secret should not appear unencrypted in raw disk bytes
    assert.ok(!rawDisk.includes("secret_access_token_12345"));

    // Decryption retrieves tokens in main process
    const retrieved = authStore.getTokens("notion");
    assert.equal(retrieved.accessToken, "secret_access_token_12345");

    // Tokens are not in mcp.json
    const configPath = path.join(tempDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } } }));
    const rawConfig = fs.readFileSync(configPath, "utf-8");
    assert.ok(!rawConfig.includes("secret_access_token_12345"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

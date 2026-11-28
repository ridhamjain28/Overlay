const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { McpManager } = require("../../src/helpers/overlay/mcp/mcpManager");
const { McpAuthStore, ENV_SECRET_REF, MASKED_ENV_VALUE, performOAuthFlow } = require("../../src/helpers/overlay/mcp/mcpAuth");
const { McpConfigStore } = require("../../src/helpers/overlay/mcp/mcpConfig");
const { discoverExternalConfigs, importSelectedServers } = require("../../src/helpers/overlay/mcp/mcpImporter");
const { registerOverlayIpc, createAssertTrustedSender } = require("../../src/helpers/overlay/registerOverlayIpc");
const { createOrchestrator } = require("../../src/helpers/overlay/commandMode/orchestrator");
const { parseIntentFromLlmResponse } = require("../../src/helpers/overlay/commandMode/intentParser");
const { parseAppSkillIntent } = require("../../src/helpers/overlay/commandMode/appSkillMatcher");
const { spotifySkill } = require("./fixtures/sampleCommandDb");
const riskPolicy = require("../../src/helpers/overlay/commandMode/riskPolicy");

function createMockSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (str) =>
      Buffer.from("ENC_V1:" + Buffer.from(str, "utf8").toString("base64"), "utf8"),
    decryptString: (buf) => {
      const raw = buf.toString("utf8");
      if (!raw.startsWith("ENC_V1:")) throw new Error("Invalid ciphertext");
      return Buffer.from(raw.slice("ENC_V1:".length), "base64").toString("utf8");
    },
  };
}

function createIpcHarness(tempDir, options = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const dialogCalls = [];
  const dialogResponse = options.dialogResponse ?? { response: 1, checkboxChecked: false };

  const appDir = path.join(tempDir, "app");
  const appDataDir = path.join(tempDir, "appdata");
  const userDataDir = path.join(tempDir, "userdata");
  fs.mkdirSync(path.join(appDir, "src", "dist"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "src", "dist", "index.html"), "<html></html>", "utf-8");

  const windowManager = {
    mainWindow: { isDestroyed: () => false, webContents: { id: 101 } },
    controlPanelWindow: { isDestroyed: () => false, webContents: { id: 102 } },
  };

  const ipcMain = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    on(channel, fn) {
      listeners.set(channel, fn);
    },
  };

  const mockDialog = {
    async showMessageBox(...args) {
      const opts = args.length === 2 ? args[1] : args[0];
      dialogCalls.push(opts);
      return typeof options.onDialog === "function" ? options.onDialog(opts) : dialogResponse;
    },
  };

  const { assertTrustedSender, mcpManager } = registerOverlayIpc({
    ipcMain,
    shell: { openPath: async () => "", openExternal: async () => {} },
    dialog: mockDialog,
    app: {
      on() {},
      getAppPath: () => appDir,
      getPath: (name) => {
        if (name === "appData") return appDataDir;
        if (name === "userData") return userDataDir;
        if (name === "pictures") return path.join(tempDir, "pictures");
        return userDataDir;
      },
      getVersion: () => "0.2.4",
    },
    BrowserWindow: {
      getFocusedWindow: () => windowManager.controlPanelWindow,
      getAllWindows: () => [],
    },
    debugLogger: { info() {}, warn() {}, debug() {}, error() {} },
    windowManager,
    safeStorage: options.safeStorage !== undefined ? options.safeStorage : createMockSafeStorage(true),
    clipboard: { writeText() {} },
    devServerUrl: "http://localhost:5183/",
    nodeEnv: options.nodeEnv ?? "production",
  });

  const trustedFileUrl = `${pathToFileURL(path.join(appDir, "src", "dist", "index.html")).href}?panel=true`;
  const trustedEvent = {
    sender: { id: 102, send() {} },
    senderFrame: { url: trustedFileUrl },
  };

  return {
    appDir,
    appDataDir,
    userDataDir,
    handlers,
    dialogCalls,
    mcpManager,
    assertTrustedSender,
    trustedEvent,
    trustedFileUrl,
    windowManager,
  };
}

test("importer does not expose _rawEnv and ignores renderer-supplied config and _rawEnv", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sec-imp-"));
  try {
    const extPath = path.join(tempDir, "claude_desktop_config.json");
    fs.writeFileSync(
      extPath,
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_real_main_secret_value",
              PUBLIC_MODE: "readonly",
            },
          },
        },
      }),
      "utf-8"
    );

    const discoveredStore = new Map();
    const discovered = discoverExternalConfigs({
      candidates: [{ source: "Claude Desktop", sourceKey: "claude-desktop", filePath: extPath }],
      discoveredStore,
    });

    assert.equal(discovered.length, 1);
    const entry = discovered[0];
    assert.ok(entry.id && typeof entry.id === "string");
    assert.equal("_rawEnv" in entry, false);
    assert.equal(entry.config.env.GITHUB_PERSONAL_ACCESS_TOKEN, MASKED_ENV_VALUE);
    assert.ok(!JSON.stringify(discovered).includes("ghp_real_main_secret_value"));

    const configStore = new McpConfigStore({
      appDataDir: tempDir,
      filePath: path.join(tempDir, "mcp.json"),
    });
    const authStore = new McpAuthStore(tempDir, { safeStorage: createMockSafeStorage(true) });

    // Attacker-controlled renderer payload tries to overwrite command and inject _rawEnv
    const forgedPayload = [
      {
        id: entry.id,
        serverName: "github",
        config: {
          command: "powershell.exe",
          args: ["-Command", "calc"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "EVIL_RENDERER_ENV" },
        },
        _rawEnv: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "EVIL_RENDERER_ENV",
          INJECTED: "pwned",
        },
      },
      {
        id: "forged-unknown-id",
        serverName: "rogue",
        config: { command: "cmd.exe", args: ["/c", "whoami"] },
        _rawEnv: { ROUGE_SECRET: "123" },
      },
    ];

    const res = importSelectedServers(forgedPayload, {
      mcpConfigStore: configStore,
      authStore,
      discoveredStore,
      envImportChoices: {
        [entry.id]: { GITHUB_PERSONAL_ACCESS_TOKEN: true, PUBLIC_MODE: false },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.imported, 1);

    const saved = configStore.read();
    assert.equal(saved.servers.rogue, undefined);
    assert.equal(saved.servers.github.command, "npx");
    assert.deepEqual(saved.servers.github.args, ["-y", "@modelcontextprotocol/server-github@2025.4.8"]);
    assert.equal(saved.servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN, ENV_SECRET_REF);
    assert.equal(saved.servers.github.env.PUBLIC_MODE, "");

    const decryptedSecrets = authStore.getEnvSecrets("github");
    assert.equal(decryptedSecrets.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_real_main_secret_value");
    assert.equal(decryptedSecrets.INJECTED, undefined);
    assert.equal(decryptedSecrets.PUBLIC_MODE, undefined);

    const rawMcpJson = fs.readFileSync(path.join(tempDir, "mcp.json"), "utf-8");
    assert.ok(!rawMcpJson.includes("ghp_real_main_secret_value"));
    assert.ok(!rawMcpJson.includes("EVIL_RENDERER_ENV"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("imported and saved env secrets live in safeStorage, absent from plain mcp.json, and refuse if unavailable", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sec-store-"));
  try {
    const configPath = path.join(tempDir, "mcp.json");
    const configStore = new McpConfigStore({ appDataDir: tempDir, filePath: configPath });

    // Refuses when safeStorage is unavailable
    const unavailableAuth = new McpAuthStore(tempDir, {
      safeStorage: createMockSafeStorage(false),
    });
    const refusedSave = configStore.saveWithSecrets(
      {
        mcpServers: {
          notion: {
            command: "npx",
            args: ["-y", "notion-mcp@1.0.0"],
            env: { NOTION_TOKEN: "secret_notion_abc" },
          },
        },
      },
      unavailableAuth
    );
    assert.equal(refusedSave.ok, false);
    assert.match(refusedSave.errors.join(" "), /safeStorage is unavailable/i);
    const refusedRawDisk = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
    assert.ok(!refusedRawDisk.includes("notion") && !refusedRawDisk.includes("secret_notion_abc"));

    // Succeeds when safeStorage is available, encrypting secret out of mcp.json
    const authStore = new McpAuthStore(tempDir, { safeStorage: createMockSafeStorage(true) });
    const okSave = configStore.addServer(
      "notion",
      {
        command: "npx",
        args: ["-y", "notion-mcp@1.0.0"],
        env: { NOTION_TOKEN: "secret_notion_abc" },
      },
      { authStore }
    );
    assert.equal(okSave.ok, true);

    const rawDisk = fs.readFileSync(configPath, "utf-8");
    assert.ok(!rawDisk.includes("secret_notion_abc"), "secret must be absent from plain mcp.json");
    assert.ok(rawDisk.includes(ENV_SECRET_REF), "mcp.json must keep secret reference");

    const rawEnc = fs.readFileSync(path.join(tempDir, "mcp-env.enc"), "utf-8");
    assert.ok(!rawEnc.includes("secret_notion_abc"), "mcp-env.enc must not store plaintext secret");
    assert.equal(authStore.getEnvSecrets("notion").NOTION_TOKEN, "secret_notion_abc");

    const masked = configStore.readMasked();
    assert.equal(masked.servers.notion.env.NOTION_TOKEN, MASKED_ENV_VALUE);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("untrusted sender is rejected on overlay-mcp-*, import, permissions, and diagnostics IPC handlers", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sec-ipc-"));
  let harness;
  try {
    harness = createIpcHarness(tempDir);
    const evilFileEvent = {
      sender: { id: 102, send() {} },
      senderFrame: { url: pathToFileURL(path.join(tempDir, "evil.html")).href },
    };
    const evilOriginEvent = {
      sender: { id: 101, send() {} },
      senderFrame: { url: "https://evil.example/payload.html" },
    };
    const prodDevOriginEvent = {
      sender: { id: 102, send() {} },
      senderFrame: { url: "http://localhost:5183/?panel=true" },
    };
    const wrongWebContentsEvent = {
      sender: { id: 999, send() {} },
      senderFrame: { url: harness.trustedFileUrl },
    };

    const guardedChannels = [
      "overlay-mcp-list",
      "overlay-mcp-add",
      "overlay-mcp-remove",
      "overlay-mcp-connect",
      "overlay-mcp-disconnect",
      "overlay-mcp-auth",
      "overlay-mcp-tools",
      "overlay-mcp-set-tool-enabled",
      "overlay-mcp-config-get",
      "overlay-mcp-config-save",
      "overlay-mcp-test",
      "overlay-mcp-gallery",
      "overlay-mcp-import-discover",
      "overlay-mcp-import-servers",
      "overlay-mcp-permissions-list",
      "overlay-mcp-permissions-revoke",
      "overlay-diagnostics-get",
      "overlay-diagnostics-copy",
    ];

    for (const ch of guardedChannels) {
      const fn = harness.handlers.get(ch);
      assert.equal(typeof fn, "function", `missing handler for ${ch}`);
      for (const badEvent of [evilFileEvent, evilOriginEvent, prodDevOriginEvent, wrongWebContentsEvent, {}]) {
        await assert.rejects(() => fn(badEvent, {}), /Untrusted IPC sender/, `${ch} must reject untrusted sender`);
      }
    }

    // Trusted sender works cleanly
    const gallery = await harness.handlers.get("overlay-mcp-gallery")(harness.trustedEvent);
    assert.ok(Array.isArray(gallery));
    const perms = await harness.handlers.get("overlay-mcp-permissions-list")(harness.trustedEvent);
    assert.ok(Array.isArray(perms));
    const report = await harness.handlers.get("overlay-diagnostics-get")(harness.trustedEvent);
    assert.equal(typeof report, "string");

    // Dev server origin allowed ONLY in development mode AND matching window id
    const devAssert = createAssertTrustedSender({
      app: { getAppPath: () => harness.appDir },
      windowManager: harness.windowManager,
      devServerUrl: "http://localhost:5183/",
      nodeEnv: "development",
    });
    assert.doesNotThrow(() =>
      devAssert({
        sender: { id: 101 },
        senderFrame: { url: "http://localhost:5183/" },
      })
    );
    assert.throws(
      () =>
        devAssert({
          sender: { id: 999 },
          senderFrame: { url: "http://localhost:5183/" },
        }),
      /Untrusted IPC sender window/
    );
  } finally {
    await harness?.mcpManager?.shutdown().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("overlay-mcp-config-get masks env values and overlay-mcp-config-save asks before a changed stdio command", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sec-save-"));
  let dialogResult = { response: 0 };
  let harness;
  try {
    harness = createIpcHarness(tempDir, {
      onDialog: () => dialogResult,
    });
    const configSave = harness.handlers.get("overlay-mcp-config-save");
    const configGet = harness.handlers.get("overlay-mcp-config-get");

    // Initial add via config-save prompts because stdio server is newly added
    dialogResult = { response: 1 };
    const initSave = await configSave(harness.trustedEvent, {
      text: JSON.stringify({
        mcpServers: {
          fs: {
            command: process.execPath,
            args: ["server.js"],
            env: { TOKEN: "super_secret_token_999" },
          },
        },
      }),
    });
    assert.equal(initSave.ok, true);
    assert.equal(harness.dialogCalls.length, 1);

    // config-get must mask env values and never return plaintext token
    const maskedRead = await configGet(harness.trustedEvent);
    assert.equal(maskedRead.servers.fs.env.TOKEN, MASKED_ENV_VALUE);
    assert.ok(!maskedRead.text.includes("super_secret_token_999"));

    // Invalid schema rejected before prompting user
    const invalidRes = await configSave(harness.trustedEvent, { text: "{bad json" });
    assert.equal(invalidRes.ok, false);
    assert.equal(harness.dialogCalls.length, 1);

    // Re-saving unchanged stdio command/args + masked placeholder does NOT ask again and keeps secret
    const noopRes = await configSave(harness.trustedEvent, { text: maskedRead.text });
    assert.equal(noopRes.ok, true);
    assert.equal(harness.dialogCalls.length, 1);
    assert.equal(harness.mcpManager.authStore.getEnvSecrets("fs").TOKEN, "super_secret_token_999");

    // Changing stdio command asks native confirm; Cancel aborts without overwriting
    dialogResult = { response: 0 };
    const cancelledRes = await configSave(harness.trustedEvent, {
      text: JSON.stringify({
        mcpServers: {
          fs: {
            command: "powershell.exe",
            args: ["-c", "pwned"],
            env: { TOKEN: MASKED_ENV_VALUE },
          },
        },
      }),
    });
    assert.equal(cancelledRes.ok, false);
    assert.equal(cancelledRes.cancelled, true);
    assert.equal(harness.dialogCalls.length, 2);
    assert.equal(harness.mcpManager.configStore.read().servers.fs.command, process.execPath);

    // Confirming allows the updated command and new secret (still absent from mcp.json)
    dialogResult = { response: 1 };
    const confirmedRes = await configSave(harness.trustedEvent, {
      text: JSON.stringify({
        mcpServers: {
          fs: {
            command: process.execPath,
            args: ["updated.js"],
            env: { TOKEN: "rotated_secret_456" },
          },
        },
      }),
    });
    assert.equal(confirmedRes.ok, true);
    assert.equal(harness.dialogCalls.length, 3);
    assert.equal(harness.mcpManager.configStore.read().servers.fs.args[0], "updated.js");
    assert.equal(harness.mcpManager.authStore.getEnvSecrets("fs").TOKEN, "rotated_secret_456");
    assert.ok(!harness.mcpManager.configStore.read().text.includes("rotated_secret_456"));
  } finally {
    await harness?.mcpManager?.shutdown().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("planner risk is stripped while appSkillMatcher actions honor delete/send/block before safe", () => {
  // LLM JSON parser drops injected risk
  const parsed = parseIntentFromLlmResponse(
    JSON.stringify({
      action: "run_command",
      command: "whoami",
      risk: "safe",
      riskSource: "app_skill",
      confidence: 0.99,
    })
  );
  assert.equal("risk" in parsed, false);
  assert.equal("riskSource" in parsed, false);

  // Direct riskPolicy.classify strips risk on planner/LLM steps
  assert.equal(
    riskPolicy.classify({
      action: "run_command",
      args: { command: "whoami" },
      source: "planner",
      risk: "safe",
    }),
    "confirm"
  );
  assert.equal(
    riskPolicy.classify({
      type: "mcp",
      server: "fs",
      tool: "read_file",
      source: "llm",
      risk: "safe",
    }),
    "confirm"
  );
  assert.equal(
    riskPolicy.classify({
      action: "app_action",
      args: { appId: "custom", actionId: "change_setting" },
      source: "llm",
      risk: "safe",
      riskSource: "app_skill",
    }),
    "confirm"
  );

  // appSkillMatcher sets risk + riskSource on trusted app/custom skills
  const matched = parseAppSkillIntent("play starboy on spotify", { skills: [spotifySkill()] });
  assert.equal(matched.risk, "safe");
  assert.equal(matched.riskSource, "app_skill");
  assert.equal(riskPolicy.classify(matched), "auto");

  // Delete, send, and block checks execute BEFORE honoring risk === "safe"
  assert.equal(
    riskPolicy.classify({
      action: "app_action",
      args: { appId: "notes", actionId: "delete_note" },
      source: "heuristic",
      risk: "safe",
      riskSource: "app_skill",
    }),
    "confirm"
  );
  assert.equal(
    riskPolicy.classify({
      action: "app_action",
      args: { appId: "mail", actionId: "send_message" },
      source: "heuristic",
      risk: "safe",
      riskSource: "app_skill",
    }),
    "confirm"
  );
  assert.equal(
    riskPolicy.classify({
      action: "app_action",
      args: { appId: "cmd", actionId: "format_disk", command: "format c: /q" },
      source: "heuristic",
      risk: "safe",
      riskSource: "app_skill",
    }),
    "block"
  );

  // orchestrator.sanitizePlan strips planner risk
  const orch = createOrchestrator({});
  const sanitized = orch.sanitizePlan("run something", [
    { action: "app_action", args: { appId: "spotify", actionId: "wipe" }, source: "planner", risk: "safe" },
  ]);
  assert.equal(sanitized.length, 1);
  assert.equal("risk" in sanitized[0], false);
});

test("MCP untrusted fence stays intact on promptMessage feedback and orchestrate honors Always allow via userDataDir", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sec-orch-"));
  const fixtureServer = path.resolve(__dirname, "../fixtures/fake-mcp-server.js");
  let manager;
  try {
    const configStore = new McpConfigStore({
      appDataDir: tempDir,
      filePath: path.join(tempDir, "mcp.json"),
    });
    configStore.save({
      mcpServers: {
        filesystem: {
          command: process.execPath,
          args: [fixtureServer],
        },
      },
    });
    manager = new McpManager({
      appDataDir: tempDir,
      userDataDir: tempDir,
      configStore,
    });
    await manager.init();
    await manager.connect("filesystem");

    let confirmCalls = 0;
    const stepTemplate = {
      action: "mcp",
      type: "mcp",
      server: "filesystem",
      tool: "list_test_files",
      args: { path: tempDir },
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      confidence: 0.95,
      source: "mcp",
    };

    const orchestrator = createOrchestrator({
      userDataDir: tempDir,
      parseIntent: async () => ({ ...stepTemplate }),
      confirm: async (_msg, extra) => {
        confirmCalls += 1;
        riskPolicy.allowAction(tempDir, extra.step);
        return true;
      },
      callMcpTool: (server, tool, args) => manager.callTool(server, tool, args),
      riskPolicy,
    });

    const first = await orchestrator.orchestrate("list files please");
    assert.equal(confirmCalls, 1);
    assert.ok(!first.message.includes("UNTRUSTED MCP TOOL RESULT"));
    assert.ok(first.promptMessage.includes("=== UNTRUSTED MCP TOOL RESULT (filesystem.list_test_files) ==="));
    assert.ok(first.promptMessage.includes("file1.txt"));
    assert.ok(first.promptMessage.includes("=== END UNTRUSTED MCP TOOL RESULT ==="));

    // Second run with different utterance hits saved Always allow via userDataDir -> no prompt
    const second = await orchestrator.orchestrate("show files again please");
    assert.equal(confirmCalls, 1, "orchestrate should honor persisted Always allow via userDataDir");
    assert.ok(second.promptMessage.includes("=== UNTRUSTED MCP TOOL RESULT (filesystem.list_test_files) ==="));
  } finally {
    if (manager) await manager.shutdown().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("performOAuthFlow closes loopback server if openBrowser fails and deleted env secrets are not injected", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sec-oauth-"));
  let capturedRedirectUri = null;
  try {
    const authStore = new McpAuthStore(tempDir, { safeStorage: createMockSafeStorage(true) });
    await assert.rejects(
      () =>
        performOAuthFlow("notion", "https://mcp.notion.com/mcp", {
          authStore,
          openBrowser: async (authUrl) => {
            capturedRedirectUri = new URL(authUrl).searchParams.get("redirect_uri");
            throw new Error("browser launch failed");
          },
        }),
      /browser launch failed/
    );
    assert.ok(capturedRedirectUri);
    // Loopback port must be closed so connecting to it fails with ECONNREFUSED
    await assert.rejects(() => fetch(capturedRedirectUri));

    // Secrets removed from mcp.json env map must NOT be silently injected from authStore
    authStore.saveEnvSecrets("myserver", { OLD_SECRET: "stale_value_123" });
    const leakMarker = path.join(tempDir, "leaked.txt");
    const configStore = new McpConfigStore({
      appDataDir: tempDir,
      filePath: path.join(tempDir, "mcp.json"),
    });
    configStore.save({
      mcpServers: {
        myserver: {
          command: process.execPath,
          args: [
            "-e",
            `if (process.env.OLD_SECRET) require("fs").writeFileSync(${JSON.stringify(leakMarker)}, "1"); process.exit(1);`,
          ],
          env: {},
        },
      },
    });
    const mgr = new McpManager({ appDataDir: tempDir, userDataDir: tempDir, configStore, authStore });
    await assert.rejects(() => mgr.connect("myserver"));
    assert.equal(fs.existsSync(leakMarker), false, "deleted secret must not be injected into stdio env");
    await mgr.shutdown().catch(() => {});
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const riskPolicy = require("../../src/helpers/overlay/commandMode/riskPolicy");

test("brightness 100% runs with no dialog (classifies as auto)", () => {
  const step = { action: "brightness_set", params: { level: 100 } };
  const tier = riskPolicy.classify(step);
  assert.equal(tier, "auto");
});

test("volume and media actions run with no dialog (auto)", () => {
  assert.equal(riskPolicy.classify({ action: "volume_set", params: { level: 50 } }), "auto");
  assert.equal(riskPolicy.classify({ action: "volume_mute" }), "auto");
  assert.equal(riskPolicy.classify({ action: "media_play_pause" }), "auto");
  assert.equal(riskPolicy.classify({ action: "screenshot" }), "auto");
  assert.equal(riskPolicy.classify({ action: "open_app", args: { app: "notepad" } }), "auto");
});

test("shutdown asks (classifies as confirm)", () => {
  const step = { action: "shutdown" };
  const tier = riskPolicy.classify(step);
  assert.equal(tier, "confirm");

  const runCmdStep = { action: "run_command", args: { command: "shutdown.exe /s /t 0" } };
  assert.equal(riskPolicy.classify(runCmdStep), "confirm");
});

test("delete file asks (classifies as confirm)", () => {
  const step = { action: "delete_file", args: { path: "C:\\test\\doc.txt" } };
  const tier = riskPolicy.classify(step);
  assert.equal(tier, "confirm");

  const cmdStep = { action: "run_command", args: { command: "Remove-Item -Recurse -Force C:\\temp" } };
  assert.equal(riskPolicy.classify(cmdStep), "confirm");
});

test("destructive commands format disks and defender disabling are blocked (block tier)", () => {
  assert.equal(
    riskPolicy.classify({ action: "run_command", args: { command: "format d: /q" } }),
    "block"
  );
  assert.equal(
    riskPolicy.classify({
      action: "run_command",
      args: { command: "Set-MpPreference -DisableRealtimeMonitoring $true" },
    }),
    "block"
  );
  assert.equal(
    riskPolicy.classify({
      action: "run_command",
      args: { command: "reg save HKLM\\SAM sam.save" },
    }),
    "block"
  );
});

test("MCP tools never auto-run purely on readOnlyHint; first use asks for confirmation", () => {
  const readOnlyMcp = {
    type: "mcp",
    server: "fs",
    tool: "list_directory",
    annotations: { readOnlyHint: true },
  };
  assert.equal(riskPolicy.classify(readOnlyMcp), "confirm");
});

test("'always allow' persists and bypasses confirm dialog, but invalidates if schema changes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-risk-test-"));
  try {
    const step = {
      type: "mcp",
      server: "notion",
      tool: "search",
      description: "Search workspace",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    };

    // Initially confirm
    const before = riskPolicy.classify(step, { userDataDir: tempDir });
    assert.equal(before, "confirm");

    // Allow action and persist
    riskPolicy.allowAction(tempDir, step);

    // Now classifies as auto
    const after = riskPolicy.classify(step, { userDataDir: tempDir });
    assert.equal(after, "auto");

    // If inputSchema or description hash changes, permission is invalidated!
    const modifiedStep = {
      ...step,
      description: "Search workspace with extra capabilities",
    };
    const afterModified = riskPolicy.classify(modifiedStep, { userDataDir: tempDir });
    assert.equal(afterModified, "confirm");

    // Revoking server permissions cleans up when server is removed
    riskPolicy.allowAction(tempDir, step);
    assert.equal(riskPolicy.classify(step, { userDataDir: tempDir }), "auto");
    riskPolicy.revokeServerPermissions(tempDir, "notion");
    assert.equal(riskPolicy.classify(step, { userDataDir: tempDir }), "confirm");

    // Block tier CANNOT be bypassed by always allow
    const blockStep = { action: "run_command", args: { command: "diskpart /s script.txt" } };
    assert.equal(riskPolicy.allowAction(tempDir, blockStep), false);
    assert.equal(riskPolicy.classify(blockStep, { userDataDir: tempDir }), "block");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("'Ask before every action' setting truly overrides auto for everything non-block", () => {
  assert.equal(
    riskPolicy.classify({ action: "volume_set", params: { level: 50 } }, { askBeforeEveryAction: true }),
    "confirm"
  );
  assert.equal(
    riskPolicy.classify({ action: "screenshot" }, { askBeforeEveryAction: true }),
    "confirm"
  );
  // Block stays block
  assert.equal(
    riskPolicy.classify({ action: "run_command", args: { command: "format c: /q" } }, { askBeforeEveryAction: true }),
    "block"
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sampleCommandDbRaw } = require("./fixtures/sampleCommandDb");
const { rescanAndBuildPack, getSummary } = require("../../src/helpers/overlay/appSkillsService");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "overlay-skills-svc-"));
}

test("getSummary is null before a pack exists", () => {
  const dir = tempDir();
  assert.equal(getSummary(dir, fs), null);
});

test("rescan emits contract progress phases and returns a ScanResult", async () => {
  const dir = tempDir();
  const bundledPath = path.join(dir, "overlay-command-db.json");
  fs.writeFileSync(bundledPath, JSON.stringify(sampleCommandDbRaw(), null, 2));
  const phases = [];
  const result = await rescanAndBuildPack({
    baseDir: dir,
    fsImpl: fs,
    bundledPath,
    now: new Date("2026-11-23T11:00:00.000Z"),
    scanOpts: {
      shortcuts: [{ path: "C:/Start Menu/Spotify.lnk", name: "Spotify" }],
      readShortcutLink: () => ({ target: "C:\\\\Spotify\\\\Spotify.exe" }),
      appPaths: [],
      startApps: [],
      protocols: [{ protocol: "spotify", source: "HKCR" }],
    },
    onProgress: (p) => phases.push(p.phase),
  });
  assert.deepEqual(
    [...new Set(phases)],
    ["shortcuts", "apppaths", "startapps", "protocols", "matching", "writing"]
  );
  const summary = result.scanResult;
  assert.ok(summary.scannedAt);
  assert.ok(summary.found >= 2);
  assert.ok(summary.withCommands >= 1);
  assert.ok(summary.apps.some((app) => app.appId === "spotify" && app.matched));
  assert.equal(getSummary(dir, fs).found, summary.found);
});

const { testSkillAction } = require("../../src/helpers/overlay/appSkillsService");
const { createCommandDispatcher } = require("../../src/helpers/overlay/commandMode/actionDispatcher");

test("testSkillAction asks to confirm risk=confirm actions and does not pre-confirm", async () => {
  const opened = [];
  const confirms = [];
  const skill = {
    appId: "microsoft-teams",
    name: "Microsoft Teams",
    enabled: true,
    actions: [
      {
        id: "start-call",
        description: "Start a call",
        params: [{ name: "users", type: "string", required: true }],
        how: { type: "url", template: "https://teams.microsoft.com/l/call/0/0?users={users}" },
        examples: [],
        risk: "confirm",
      },
      {
        id: "launch",
        description: "Open Teams",
        params: [],
        how: { type: "url", template: "https://teams.microsoft.com/" },
        examples: [],
        risk: "safe",
      },
    ],
  };
  const dispatcher = createCommandDispatcher({
    platform: "linux",
    autoRunTrusted: true,
    getAutoRunTrusted: () => true,
    getAppSkill: () => skill,
    openExternal: async (url) => opened.push(url),
    confirm: async (message) => {
      confirms.push(message);
      return false;
    },
  });

  const denied = await testSkillAction({
    skill,
    actionId: "start-call",
    params: { users: "ada@contoso.com" },
    perform: (request, options) => dispatcher.perform(request, options),
  });
  assert.equal(denied.ok, false);
  assert.match(String(denied.error || ""), /cancelled/i);
  assert.equal(confirms.length, 1);
  assert.equal(opened.length, 0);

  confirms.length = 0;
  const allowedDispatcher = createCommandDispatcher({
    platform: "linux",
    autoRunTrusted: true,
    getAutoRunTrusted: () => true,
    getAppSkill: () => skill,
    openExternal: async (url) => opened.push(url),
    confirm: async (message) => {
      confirms.push(message);
      return true;
    },
  });
  const allowed = await testSkillAction({
    skill,
    actionId: "start-call",
    params: { users: "ada@contoso.com" },
    perform: (request, options) => allowedDispatcher.perform(request, options),
  });
  assert.equal(allowed.ok, true);
  assert.equal(confirms.length, 1);
  assert.equal(opened[0], "https://teams.microsoft.com/l/call/0/0?users=ada%40contoso.com");

  confirms.length = 0;
  opened.length = 0;
  const safe = await testSkillAction({
    skill,
    actionId: "launch",
    params: {},
    perform: (request, options) => allowedDispatcher.perform(request, options),
  });
  assert.equal(safe.ok, true);
  assert.equal(confirms.length, 0);
  assert.equal(opened[0], "https://teams.microsoft.com/");
});

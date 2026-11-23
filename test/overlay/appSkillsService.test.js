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

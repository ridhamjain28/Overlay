const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sampleCommandDb } = require("./fixtures/sampleCommandDb");
const {
  buildPackFromScan,
  setSkillEnabled,
  readSkill,
  mergeSkill,
  toScanResult,
} = require("../../src/helpers/overlay/appSkillStore");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "overlay-skills-"));
}

test("pack generation copies DB templates and gives unmatched apps a generic launch", () => {
  const dir = tempDir();
  const db = sampleCommandDb();
  const { catalog, skills } = buildPackFromScan({
    baseDir: dir,
    db,
    now: new Date("2026-11-23T11:00:00.000Z"),
    catalogApps: [
      { id: "spotify", name: "Spotify", exeName: "spotify.exe", target: "C:\\\\Spotify\\\\Spotify.exe", source: "start_menu" },
      { id: "weird-app", name: "Ridham Secret Tool", exeName: "secrettool.exe", target: "C:\\\\Tools\\\\secrettool.exe", source: "start_menu" },
    ],
    fsImpl: fs,
  });
  const summary = toScanResult(catalog, skills);
  assert.ok(summary.found >= 2);
  assert.ok(summary.withCommands >= 1);
  const spotify = skills.find((s) => s.appId === "spotify");
  assert.equal(spotify.source, "db");
  assert.ok(spotify.actions.some((a) => a.id === "play_track"));
  const row = summary.apps.find((app) => app.appId === "spotify");
  assert.equal(row.matched, true);
  assert.ok(row.actionsCount >= 2);
  const generic = skills.find((s) => s.appId === "ridham-secret-tool" || s.name === "Ridham Secret Tool");
  assert.ok(generic);
  assert.equal(generic.source, "generic");
  assert.equal(generic.actions[0].id, "launch");
  assert.ok(skills.some((s) => s.appId === "gmail" && s.alwaysAvailable));
  assert.ok(fs.existsSync(path.join(dir, "apps", "spotify.json")));
  assert.ok(fs.existsSync(path.join(dir, "apps-catalog.json")));
});

test("rescan merges and keeps user edits", () => {
  const dir = tempDir();
  const db = sampleCommandDb();
  const apps = [{ id: "spotify", name: "Spotify", exeName: "spotify.exe", target: "C:\\\\Spotify\\\\Spotify.exe" }];
  buildPackFromScan({ baseDir: dir, db, catalogApps: apps, fsImpl: fs });
  setSkillEnabled(dir, "spotify", false, fs);
  const existing = readSkill(dir, "spotify", fs);
  existing.actions.find((a) => a.id === "play_track").examples.push({
    utterance: "play my coding beats",
    params: { query: "coding beats" },
  });
  existing.actions.push({
    id: "custom_focus",
    description: "User added",
    params: [],
    how: { type: "uri", template: "spotify:" },
    examples: [],
    risk: "safe",
    source: "user",
  });
  fs.writeFileSync(path.join(dir, "apps", "spotify.json"), JSON.stringify(existing, null, 2));

  const again = buildPackFromScan({ baseDir: dir, db, catalogApps: apps, fsImpl: fs });
  const merged = again.skills.find((s) => s.appId === "spotify");
  assert.equal(merged.enabled, false);
  assert.ok(merged.actions.some((a) => a.id === "custom_focus"));
  const play = merged.actions.find((a) => a.id === "play_track");
  assert.ok(play.examples.some((ex) => ex.utterance === "play my coding beats"));
  assert.ok(play.examples.some((ex) => /starboy/i.test(ex.utterance)));
});

test("setSkillEnabled can toggle a single action", () => {
  const dir = tempDir();
  const db = sampleCommandDb();
  const apps = [{ id: "spotify", name: "Spotify", exeName: "spotify.exe", target: "C:\\\\Spotify\\\\Spotify.exe" }];
  buildPackFromScan({ baseDir: dir, db, catalogApps: apps, fsImpl: fs });
  const skill = setSkillEnabled(dir, "spotify", false, fs, "play_track");
  const play = skill.actions.find((a) => a.id === "play_track");
  assert.equal(play.enabled, false);
  assert.equal(skill.enabled, true);
  const launch = skill.actions.find((a) => a.id === "launch");
  assert.notEqual(launch.enabled, false);
});

test("mergeSkill keeps enabled and unions aliases", () => {
  const merged = mergeSkill(
    { appId: "x", enabled: false, aliases: ["old"], actions: [] },
    { appId: "x", enabled: true, aliases: ["new"], actions: [] }
  );
  assert.equal(merged.enabled, false);
  assert.deepEqual(merged.aliases.sort(), ["new", "old"]);
});

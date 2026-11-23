const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadBundledCommandDb,
  loadCommandDb,
  isRemoteEnabled,
  appMatchesTemplate,
  normalizeDb,
} = require("../../src/helpers/overlay/commandMode/commandDb");
const { sampleCommandDb } = require("./fixtures/sampleCommandDb");

test("bundled command DB is versioned, has no remote URL, and uses the shared schema", () => {
  const db = loadBundledCommandDb();
  assert.equal(db.version, 1);
  assert.ok(db.updatedAt);
  assert.equal(db.remoteUrl, "");
  assert.equal(isRemoteEnabled(db), false);
  assert.ok(db.apps.length >= 40, `expected the shared ~40-app DB, got ${db.apps.length}`);
  const ids = db.apps.map((app) => app.appId);
  for (const needed of ["google-chrome", "microsoft-edge", "spotify", "gmail", "google-calendar", "notepad", "vscode"]) {
    assert.ok(ids.includes(needed), needed);
  }
  const chrome = db.apps.find((app) => app.appId === "google-chrome");
  assert.ok(Array.isArray(chrome.match.exe));
  assert.ok(chrome.match.exe.includes("chrome.exe"));
  assert.ok(chrome.match.nameRegex.length);
  for (const app of db.apps) {
    assert.ok(app.appId && app.name);
    assert.ok(Array.isArray(app.actions) && app.actions.length >= 1, app.appId);
    const match = app.match;
    assert.ok(Array.isArray(match.exe) && Array.isArray(match.aumidPrefix) && Array.isArray(match.protocols) && Array.isArray(match.nameRegex));
  }
});

test("match rules use exe, aumidPrefix, protocols and nameRegex", () => {
  const spotify = sampleCommandDb().apps.find((app) => app.appId === "spotify");
  assert.ok(appMatchesTemplate({ exeName: "spotify.exe", name: "Other" }, spotify));
  assert.ok(appMatchesTemplate({ aumid: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", name: "x" }, spotify));
  assert.ok(appMatchesTemplate({ protocols: ["spotify:"], name: "x" }, spotify));
  assert.ok(appMatchesTemplate({ name: "Spotify" }, spotify));
  assert.equal(appMatchesTemplate({ name: "Notepad", exeName: "notepad.exe" }, spotify), false);
});

test("loader accepts legacy match field names", () => {
  const db = normalizeDb({
    version: 2,
    updatedAt: "2026-11-23T00:00:00.000Z",
    apps: [{
      appId: "legacy",
      name: "Legacy",
      aliases: [],
      match: { exeNames: ["legacy.exe"], aumidPrefixes: ["Legacy_"], displayNameRegexes: ["^Legacy$"] },
      actions: [],
    }],
  });
  const app = db.apps[0];
  assert.deepEqual(app.match.exe, ["legacy.exe"]);
  assert.deepEqual(app.match.aumidPrefix, ["Legacy_"]);
  assert.deepEqual(app.match.nameRegex, ["^Legacy$"]);
  assert.ok(appMatchesTemplate({ exeName: "legacy.exe" }, app));
});

test("empty remoteUrl never fetches; a configured URL falls back if fetch fails", async () => {
  let calls = 0;
  const bundled = await loadCommandDb({
    remoteUrl: "",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(bundled.version, 1);
  assert.equal(calls, 0);

  const fallback = await loadCommandDb({
    remoteUrl: "https://example.invalid/overlay-command-db.json",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network down");
    },
  });
  assert.equal(calls, 1);
  assert.equal(fallback.apps.length, bundled.apps.length);

  const remote = await loadCommandDb({
    remoteUrl: "https://example.test/db.json",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        version: 9,
        updatedAt: "2026-11-23T00:00:00.000Z",
        apps: [{ appId: "remote-only", name: "Remote", aliases: [], match: { exe: ["remote.exe"] }, actions: [] }],
      }),
    }),
  });
  assert.equal(remote.version, 9);
  assert.equal(remote.apps[0].appId, "remote-only");
  assert.deepEqual(remote.apps[0].match.exe, ["remote.exe"]);
});

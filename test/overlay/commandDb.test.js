const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadBundledCommandDb,
  loadCommandDb,
  isRemoteEnabled,
  appMatchesTemplate,
} = require("../../src/helpers/overlay/commandMode/commandDb");

test("bundled command DB is versioned and has no remote URL", () => {
  const db = loadBundledCommandDb();
  assert.equal(db.version, 1);
  assert.equal(db.remoteUrl, "");
  assert.equal(isRemoteEnabled(db), false);
  const ids = db.apps.map((app) => app.appId);
  for (const needed of ["google-chrome", "microsoft-edge", "spotify", "gmail", "google-calendar", "notepad"]) {
    assert.ok(ids.includes(needed), needed);
  }
});

test("match rules use exe names, AUMID prefixes, protocols and display names", () => {
  const db = loadBundledCommandDb();
  const spotify = db.apps.find((app) => app.appId === "spotify");
  assert.ok(appMatchesTemplate({ exeName: "spotify.exe", name: "Other" }, spotify));
  assert.ok(appMatchesTemplate({ aumid: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", name: "x" }, spotify));
  assert.ok(appMatchesTemplate({ protocols: ["spotify:"], name: "x" }, spotify));
  assert.ok(appMatchesTemplate({ name: "Spotify" }, spotify));
  assert.equal(appMatchesTemplate({ name: "Notepad", exeName: "notepad.exe" }, spotify), false);
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
      json: async () => ({ version: 9, remoteUrl: "https://example.test/db.json", apps: [{ appId: "remote-only", name: "Remote", aliases: [], match: {}, actions: [] }] }),
    }),
  });
  assert.equal(remote.version, 9);
  assert.equal(remote.apps[0].appId, "remote-only");
});

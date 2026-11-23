const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  recordExample,
  searchExamples,
  deleteExample,
  readAll,
  isRiskyExample,
  MAX_EXAMPLES,
} = require("../../src/helpers/overlay/learnedStore");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "overlay-learn-"));
}

const safe = {
  utterance: "play starboy on spotify",
  appId: "spotify",
  actionId: "play_track",
  params: { query: "starboy" },
  source: "correction",
  risk: "safe",
};

test("records, dedupes, retrieves with BM25, and deletes", () => {
  const dir = tempDir();
  assert.equal(recordExample(dir, safe, fs, { now: 1 }).ok, true);
  assert.equal(recordExample(dir, { ...safe, params: { query: "STARBOY" } }, fs, { now: 2 }).ok, true);
  assert.equal(readAll(dir, fs).length, 1);
  recordExample(dir, { ...safe, utterance: "listen to my focus tracks on spotify", params: { query: "focus tracks" }, id: "learn_3" }, fs, { now: 3 });
  recordExample(dir, { utterance: "open notepad", appId: "notepad", actionId: "launch", risk: "safe" }, fs, { now: 4 });
  const hits = searchExamples(dir, "focus tracks spotify", { k: 3, fsImpl: fs });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].utterance, /focus tracks/i);
  assert.equal(deleteExample(dir, "learn_3", fs).removed, 1);
  assert.equal(readAll(dir, fs).some((e) => e.id === "learn_3"), false);
});

test("never learns risky actions and caps at 500", () => {
  assert.equal(isRiskyExample({ ...safe, risk: "confirm" }), true);
  assert.equal(isRiskyExample({ ...safe, actionId: "run_command", plan: { action: "run_command" } }), true);
  const dir = tempDir();
  assert.equal(recordExample(dir, { ...safe, risk: "confirm" }, fs).ok, false);
  for (let i = 0; i < MAX_EXAMPLES + 5; i++) {
    recordExample(
      dir,
      { utterance: `play song ${i} on spotify`, appId: "spotify", actionId: "play_track", risk: "safe" },
      fs,
      { now: i }
    );
  }
  assert.equal(readAll(dir, fs).length, MAX_EXAMPLES);
  assert.equal(readAll(dir, fs)[0].utterance, "play song 5 on spotify");
});

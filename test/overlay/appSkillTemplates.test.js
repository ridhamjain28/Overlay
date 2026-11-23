const test = require("node:test");
const assert = require("node:assert/strict");
const { fillActionTemplate, sanitizeCliArg, validateParams } = require("../../src/helpers/overlay/appSkillTemplates");

test("URI and URL templates encode query values", () => {
  const uri = fillActionTemplate(
    { params: [{ name: "query", required: true }], how: { type: "uri", template: "spotify:search:{query}" } },
    { query: "star boy" }
  );
  assert.equal(uri.ok, true);
  assert.equal(uri.value, "spotify:search:star%20boy");

  const url = fillActionTemplate(
    { params: [{ name: "query", required: true }], how: { type: "url", template: "https://www.youtube.com/results?search_query={query}" } },
    { query: "lo-fi beats" }
  );
  assert.equal(url.value, "https://www.youtube.com/results?search_query=lo-fi%20beats");
});

test("CLI templates stay injection-safe", () => {
  const ok = fillActionTemplate(
    { params: [], how: { type: "cli", template: "{target}" } },
    { target: "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe" }
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.exe, "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe");
  assert.deepEqual(ok.args, []);
  assert.throws(() => sanitizeCliArg("foo & calc.exe"), /unsafe/);
  const bad = fillActionTemplate(
    { params: [{ name: "query", required: false }], how: { type: "cli", template: "code {query}" } },
    { query: "x && shutdown /s" }
  );
  assert.equal(bad.ok, false);
});

test("required params and safe key allow-list are enforced", () => {
  const missing = validateParams({ params: [{ name: "query", required: true }] }, {});
  assert.equal(missing.ok, false);
  const keys = fillActionTemplate({ params: [], how: { type: "keys", template: "MediaPlayPause" } }, {});
  assert.equal(keys.ok, true);
  const unsafe = fillActionTemplate({ params: [], how: { type: "keys", template: "Win+R" } }, {});
  assert.equal(unsafe.ok, false);
});

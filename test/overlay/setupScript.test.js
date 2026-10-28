const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const setup = require("../../scripts/setup.js");

test("setup: models already pulled are not pulled again (name:latest matches)", () => {
  assert.deepEqual(
    setup.missingModels(
      ["qwen3.5:4b-q4_K_M", "foo:latest"],
      ["qwen3.5:4b-q4_K_M", "foo", "qwen3:4b-instruct"]
    ),
    ["qwen3:4b-instruct"]
  );
  assert.deepEqual(setup.missingModels(null, ["a"]), ["a"]);
});

test("setup: starter .env comments out every key and keeps normal settings", () => {
  const out = setup.buildUserEnv(
    "# comment\nOLLAMA_API_KEY=\nOPENCLAW_TOKEN=abc\nOVERLAY_OLLAMA_SEARCH_DAILY_CAP=20\nSEARXNG_URL=\n"
  );
  assert.match(out, /^# OLLAMA_API_KEY=$/m);
  assert.match(out, /^# OPENCLAW_TOKEN=$/m, "example values for secrets are never copied");
  assert.doesNotMatch(out, /abc/);
  assert.match(out, /^OVERLAY_OLLAMA_SEARCH_DAILY_CAP=20$/m);
  assert.match(out, /^# SEARXNG_URL=$/m);
  assert.doesNotMatch(out, /^[A-Z_]*(KEY|TOKEN)=/m);
});

test("setup: an existing .env is never overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-setup-"));
  const a = path.join(dir, "Overlay");
  const b = path.join(dir, "Overlay-development");
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, ".env"), "MINE=1\n");
  const res = setup.ensureUserEnv([a, b]);
  assert.deepEqual(
    res.map((r) => r.created),
    [false, true]
  );
  assert.equal(fs.readFileSync(path.join(a, ".env"), "utf8"), "MINE=1\n");
  assert.match(fs.readFileSync(path.join(b, ".env"), "utf8"), /# OLLAMA_API_KEY=/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("setup: user-data folders match the app's names", () => {
  const dirs = setup.userDataDirs(
    "win32",
    { APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
    "C:\\Users\\x"
  );
  assert.equal(path.basename(dirs[0]), "Overlay");
  assert.equal(path.basename(dirs[1]), "Overlay-development");
});

test("setup: flags and Node version check", () => {
  const o = setup.parseArgs(["--skip-models", "--only-default-model"]);
  assert.equal(o.skipModels, true);
  assert.equal(o.onlyDefaultModel, true);
  assert.equal(o.forceInstall, false);
  assert.equal(setup.nodeMajor("24.11.1"), 24);
  assert.equal(setup.nodeMajor("22.1.0") < 24, true);
});

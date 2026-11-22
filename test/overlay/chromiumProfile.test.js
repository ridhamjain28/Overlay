const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  parseChromiumLastProfileDirectory,
  chromiumProductFromAppName,
  chromiumUserDataDir,
  readLastProfileDirectory,
  chromiumLaunchArgs,
} = require("../../src/helpers/overlay/chromiumProfile");

test("parseChromiumLastProfileDirectory reads profile.last_used", () => {
  assert.equal(
    parseChromiumLastProfileDirectory('{"profile":{"last_used":"Default"}}'),
    "Default"
  );
  assert.equal(
    parseChromiumLastProfileDirectory({ profile: { last_used: "Profile 1" } }),
    "Profile 1"
  );
});

test("parseChromiumLastProfileDirectory falls back to Default", () => {
  assert.equal(parseChromiumLastProfileDirectory("{"), "Default");
  assert.equal(parseChromiumLastProfileDirectory({}), "Default");
  assert.equal(parseChromiumLastProfileDirectory({ profile: {} }), "Default");
});

test("parseChromiumLastProfileDirectory uses info_cache when last_used is missing", () => {
  assert.equal(
    parseChromiumLastProfileDirectory({
      profile: { info_cache: { Default: {}, "Profile 2": {} } },
    }),
    "Default"
  );
});

test("chromiumProductFromAppName maps chrome, edge, and brave", () => {
  assert.equal(chromiumProductFromAppName("Google Chrome"), "chrome");
  assert.equal(chromiumProductFromAppName("chrome"), "chrome");
  assert.equal(chromiumProductFromAppName("Microsoft Edge"), "edge");
  assert.equal(chromiumProductFromAppName("brave browser"), "brave");
  assert.equal(chromiumProductFromAppName("notepad"), null);
});

test("chromiumUserDataDir is under LOCALAPPDATA", () => {
  const env = { LOCALAPPDATA: "C:\\\\Users\\\\x\\\\AppData\\\\Local" };
  assert.equal(
    chromiumUserDataDir("chrome", env),
    path.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data")
  );
  assert.ok(chromiumUserDataDir("edge", env).endsWith(path.join("Microsoft", "Edge", "User Data")));
  assert.ok(
    chromiumUserDataDir("brave", env).includes(path.join("BraveSoftware", "Brave-Browser", "User Data"))
  );
});

test("readLastProfileDirectory reads Local State through the fs stub", () => {
  const files = {
    [path.join("C:", "User Data", "Local State")]: '{"profile":{"last_used":"Profile 1"}}',
  };
  const fsImpl = {
    readFileSync: (p) => {
      if (files[p]) return files[p];
      throw new Error("missing");
    },
  };
  assert.equal(readLastProfileDirectory(path.join("C:", "User Data"), fsImpl), "Profile 1");
  assert.equal(readLastProfileDirectory(path.join("C:", "Missing"), fsImpl), "Default");
});

test("chromiumLaunchArgs always include --profile-directory", () => {
  assert.deepEqual(chromiumLaunchArgs("Default"), ["--profile-directory=Default"]);
  assert.deepEqual(chromiumLaunchArgs("Profile 1", "https://example.com/"), [
    "--profile-directory=Profile 1",
    "https://example.com/",
  ]);
  assert.deepEqual(chromiumLaunchArgs("  ", "https://a.test"), [
    "--profile-directory=Default",
    "https://a.test",
  ]);
});

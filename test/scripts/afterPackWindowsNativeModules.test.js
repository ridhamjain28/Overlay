const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Arch } = require("app-builder-lib");

const { verifyWindowsNativeModules } = require("../../scripts/afterPack");

function makeAppOutDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-native-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("fails when better-sqlite3's native binary was not packed", (t) => {
  const appOutDir = makeAppOutDir(t);
  const context = { electronPlatformName: "win32", arch: Arch.x64, appOutDir };
  assert.throws(() => verifyWindowsNativeModules(context), /missing native module.*better_sqlite3\.node/);
});

test("skips the check for non-Windows builds", (t) => {
  const appOutDir = makeAppOutDir(t);
  const context = { electronPlatformName: "linux", arch: Arch.x64, appOutDir };
  assert.doesNotThrow(() => verifyWindowsNativeModules(context));
});

// electron-builder beforePack hook
//
// On Windows x64, make sure better-sqlite3's native binary exists and loads in
// Electron before packing (downloads the official prebuilt if needed), so the
// installer can never ship without it. afterPack.js verifies the result.
const { Arch } = require("app-builder-lib");
const { ensureBetterSqlite3 } = require("./ensure-native-deps");

exports.default = async function (context) {
  if (context.electronPlatformName !== "win32" || Arch[context.arch] !== "x64") return;
  if (process.platform !== "win32") {
    console.warn("  beforePack: cross-building Windows; cannot check better-sqlite3 here");
    return;
  }
  ensureBetterSqlite3();
};

#!/usr/bin/env node
// Make sure better-sqlite3 has a working native binary for Electron before a
// Windows x64 package is built.
//
// better-sqlite3 has to be compiled for Electron's ABI. Without Visual Studio
// Build Tools that compile fails (and a failed rebuild deletes build/Release),
// so we use the official prebuilt from the better-sqlite3 GitHub release.
// The binary is checked by loading it inside Electron (no window is opened)
// and running a tiny in-memory query. If it is missing or broken it is
// downloaded again; if it still does not work this script fails loudly.
//
// Used by: scripts/beforePack.js (every electron-builder run),
// scripts/install-native-deps.js (postinstall fallback) and `npm run ensure:native-deps`.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const moduleDir = path.join(root, "node_modules", "better-sqlite3");
const binaryPath = path.join(moduleDir, "build", "Release", "better_sqlite3.node");

// Electron major version -> official better-sqlite3 prebuilt for Windows x64.
const PREBUILT_URLS = {
  43: "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.12.0/better-sqlite3-v12.12.0-electron-v148-win32-x64.tar.gz",
};

function electronVersion() {
  try {
    return require(path.join(root, "node_modules", "electron", "package.json")).version;
  } catch {
    return null;
  }
}

function electronExe() {
  return path.join(root, "node_modules", "electron", "dist", "electron.exe");
}

// Load a better_sqlite3.node inside Electron (as plain Node, no window) and do
// an insert + select. Returns true/false, or null when Electron is not installed.
function loadsInElectron(nodeFile = binaryPath) {
  if (!fs.existsSync(nodeFile)) return false;
  const exe = electronExe();
  if (!fs.existsSync(exe)) return null;

  const code = [
    `const Database = require(${JSON.stringify(moduleDir)});`,
    `const db = new Database(":memory:", { nativeBinding: ${JSON.stringify(nodeFile)} });`,
    `db.exec("CREATE TABLE t (x INTEGER)");`,
    `db.prepare("INSERT INTO t VALUES (?)").run(42);`,
    `if (db.prepare("SELECT x FROM t").get().x !== 42) process.exit(2);`,
    `console.log("sqlite ok (abi " + process.versions.modules + ")");`,
  ].join("\n");

  const result = spawnSync(exe, ["-e", code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) {
    console.log(`[overlay] ${nodeFile}: ${result.stdout.trim()}`);
    return true;
  }
  console.warn(`[overlay] ${nodeFile} does not load in Electron:\n${result.stderr || result.stdout}`);
  return false;
}

function downloadPrebuilt(version) {
  const url = PREBUILT_URLS[Number(String(version).split(".")[0])];
  if (!url) {
    throw new Error(`No better-sqlite3 prebuilt URL for Electron ${version}; add one to PREBUILT_URLS`);
  }
  const prebuildBin = path.join(root, "node_modules", "prebuild-install", "bin.js");
  if (!fs.existsSync(prebuildBin)) {
    throw new Error("prebuild-install is missing; cannot fetch the better-sqlite3 prebuilt");
  }
  console.log(`[overlay] Downloading the better-sqlite3 prebuilt for Electron ${version}`);
  const result = spawnSync(
    process.execPath,
    [prebuildBin, "--runtime", "electron", "--target", version, "--arch", "x64", "--download", url],
    { cwd: moduleDir, stdio: "inherit", windowsHide: true }
  );
  if (result.status !== 0) throw new Error("better-sqlite3 prebuilt download failed");
}

// Only Windows x64 hosts are handled here; other platforms build from source
// through electron-builder as usual.
function ensureBetterSqlite3() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    console.log("[overlay] ensure-native-deps: not Windows x64, nothing to do");
    return;
  }
  if (loadsInElectron() === true) return;

  const version = electronVersion();
  if (!version) throw new Error("Electron is not installed in node_modules");
  downloadPrebuilt(version);

  const check = loadsInElectron();
  if (check === false || !fs.existsSync(binaryPath)) {
    throw new Error(`better-sqlite3 still does not work for Electron ${version} (${binaryPath})`);
  }
}

module.exports = { ensureBetterSqlite3, loadsInElectron, downloadPrebuilt, binaryPath };

if (require.main === module) {
  try {
    ensureBetterSqlite3();
  } catch (error) {
    console.error(`[overlay] ${error.message}`);
    process.exit(1);
  }
}

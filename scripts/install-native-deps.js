#!/usr/bin/env node
// Overlay postinstall: rebuild native modules for Electron.
//
// Upstream runs `electron-builder install-app-deps`, which compiles
// better-sqlite3 from source when no prebuilt binary exists. On Windows that
// needs Visual Studio Build Tools. better-sqlite3 12.11.1 ships no prebuilt for
// Electron 43 (ABI 148), but the official v12.12.0 GitHub release does. If the
// rebuild fails on Windows x64, fall back to downloading that prebuilt
// (see scripts/ensure-native-deps.js, which also checks it loads in Electron).
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

if (process.env.OVERLAY_SKIP_NATIVE_REBUILD === "1") {
  console.log("[overlay] OVERLAY_SKIP_NATIVE_REBUILD=1, skipping native rebuild");
  process.exit(0);
}

// `shell` is only needed for npx.cmd on Windows.
const rebuild = spawnSync(npx, ["electron-builder", "install-app-deps"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (rebuild.status === 0) process.exit(0);

if (process.platform !== "win32" || process.arch !== "x64") {
  console.error(
    "[overlay] Native rebuild failed. Install C++ build tools and run `npm run postinstall` again."
  );
  process.exit(1);
}

// A failed rebuild deletes better-sqlite3's build/Release, so put the
// prebuilt back (and verify it) before giving up.
console.log("[overlay] Rebuild failed; using the better-sqlite3 prebuilt instead");
try {
  require("./ensure-native-deps").ensureBetterSqlite3();
  console.log("[overlay] better-sqlite3 prebuilt installed.");
} catch (error) {
  console.error(`[overlay] ${error.message}`);
  process.exit(1);
}

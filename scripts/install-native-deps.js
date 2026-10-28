#!/usr/bin/env node
// Overlay postinstall: rebuild native modules for Electron.
//
// Upstream runs `electron-builder install-app-deps`, which compiles
// better-sqlite3 from source when no prebuilt binary exists. On Windows that
// needs Visual Studio Build Tools. better-sqlite3 12.11.1 ships no prebuilt for
// Electron 43 (ABI 148), but the official v12.12.0 GitHub release does. If the
// rebuild fails on Windows x64, fall back to downloading that prebuilt
// (verified to load in Electron 43.8.3 on Windows 11).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// `shell` is only needed for npx.cmd on Windows. Running node itself through a
// shell would break on paths with spaces such as "C:\Program Files\nodejs".
function run(cmd, args, cwd = root, shell = process.platform === "win32") {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell });
  return result.status === 0;
}

function electronVersion() {
  try {
    return require(path.join(root, "node_modules", "electron", "package.json")).version;
  } catch {
    return null;
  }
}

const FALLBACKS = {
  // electron major -> prebuilt URL
  43: "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.12.0/better-sqlite3-v12.12.0-electron-v148-win32-x64.tar.gz",
};

if (process.env.OVERLAY_SKIP_NATIVE_REBUILD === "1") {
  console.log("[overlay] OVERLAY_SKIP_NATIVE_REBUILD=1, skipping native rebuild");
  process.exit(0);
}

if (run(npx, ["electron-builder", "install-app-deps"])) process.exit(0);

const version = electronVersion();
const major = version ? Number(version.split(".")[0]) : null;
const url = FALLBACKS[major];
if (process.platform !== "win32" || process.arch !== "x64" || !url) {
  console.error(
    "[overlay] Native rebuild failed. Install C++ build tools and run `npm run postinstall` again."
  );
  process.exit(1);
}

console.log(
  `[overlay] Rebuild failed; downloading the better-sqlite3 prebuilt for Electron ${version}`
);
const moduleDir = path.join(root, "node_modules", "better-sqlite3");
const prebuildBin = path.join(root, "node_modules", "prebuild-install", "bin.js");
if (!fs.existsSync(prebuildBin)) {
  console.error("[overlay] prebuild-install is missing; cannot fetch the prebuilt binary.");
  process.exit(1);
}
const ok = run(
  process.execPath,
  [prebuildBin, "--runtime", "electron", "--target", version, "--arch", "x64", "--download", url],
  moduleDir,
  false
);
if (!ok) {
  console.error("[overlay] Prebuilt download failed.");
  process.exit(1);
}
console.log("[overlay] better-sqlite3 prebuilt installed.");

// Overlay: keeps downloaded GPU packs across reinstalls and across the
// Overlay / Overlay-development / Overlay-staging data folders.
//
// Each install keeps its packs in userData/bin/<dirName>. A fresh install, a
// different build channel, or an uninstall that wiped userData all start with
// no pack, so the app offered GPU acceleration again and re-downloaded a pack
// that was already on disk. On startup, a missing pack is brought back from a
// mirror in ~/.cache/openwhispr/gpu-packs (which the uninstaller keeps) or from
// a sibling channel's data folder. Mirrors are hard links, so they cost no
// extra disk space; when a hard link is impossible (another drive) no mirror
// is kept. Deleting a pack in Settings deletes its mirror too, so a deleted
// pack never comes back.
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHANNEL_SUFFIXES = ["", "-development", "-staging"];

function defaultSharedRoot() {
  return path.join(os.homedir(), ".cache", "openwhispr", "gpu-packs");
}

function packFiles(dir, assetConfig) {
  if (!assetConfig) return null;
  try {
    const binary = path.join(dir, assetConfig.outputName);
    if (!fs.statSync(binary).isFile()) return null;
    for (const library of assetConfig.requiredLibraries || []) {
      if (!fs.statSync(path.join(dir, library)).isFile()) return null;
    }
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

function isCompletePack(dir, assetConfig) {
  return packFiles(dir, assetConfig) !== null;
}

function samePack(a, b, assetConfig) {
  const filesA = packFiles(a, assetConfig);
  const filesB = packFiles(b, assetConfig);
  if (!filesA || !filesB || filesA.length !== filesB.length) return false;
  try {
    return filesA.every((name) => {
      const statA = fs.statSync(path.join(a, name));
      const statB = fs.statSync(path.join(b, name));
      return statA.size === statB.size;
    });
  } catch {
    return false;
  }
}

// Sibling data folders of the same app on other build channels.
function siblingUserDataDirs(userDataDir) {
  const parent = path.dirname(userDataDir);
  const name = path.basename(userDataDir);
  const base = name.replace(/-(development|staging)$/i, "");
  return CHANNEL_SUFFIXES.map((suffix) => path.join(parent, base + suffix)).filter(
    (dir) => path.resolve(dir).toLowerCase() !== path.resolve(userDataDir).toLowerCase()
  );
}

function candidateSources(manager, { userDataDir, sharedRoot }) {
  const dirName = manager.config.dirName;
  return [
    path.join(sharedRoot, dirName),
    ...siblingUserDataDirs(userDataDir).map((dir) => path.join(dir, "bin", dirName)),
  ];
}

// Hard links each file of a flat pack directory into dest. With allowCopy a
// file that can't be linked (another volume) is copied instead.
function cloneFlatDir(src, dest, { allowCopy }) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    try {
      fs.linkSync(from, to);
    } catch (error) {
      if (!allowCopy) throw error;
      fs.copyFileSync(from, to);
    }
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(to, fs.statSync(from).mode);
      } catch {}
    }
  }
}

// Builds the directory next to its target and swaps it in with one rename, as
// the download does, so a crash never leaves a half-copied pack behind.
function installDir(src, target, assetConfig, { allowCopy }) {
  const staging = path.join(path.dirname(target), `temp-extract-stage-${path.basename(target)}`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    cloneFlatDir(src, staging, { allowCopy });
    if (!isCompletePack(staging, assetConfig)) throw new Error("incomplete copy");
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// fresh: the pack was just downloaded, which overrides an earlier delete.
function mirrorGpuPack(manager, { sharedRoot = defaultSharedRoot(), logger, fresh = true } = {}) {
  const assetConfig = manager._getAssetConfig?.();
  if (!assetConfig || !isCompletePack(manager.binDir, assetConfig)) return false;
  const marker = deletedMarker(sharedRoot, manager);
  if (fresh) {
    try {
      fs.rmSync(marker, { force: true });
    } catch {}
  } else if (fs.existsSync(marker)) {
    return false;
  }
  const mirror = path.join(sharedRoot, manager.config.dirName);
  if (samePack(manager.binDir, mirror, assetConfig)) return true;
  try {
    fs.mkdirSync(sharedRoot, { recursive: true });
    installDir(manager.binDir, mirror, assetConfig, { allowCopy: false });
    return true;
  } catch (error) {
    logger?.debug?.("GPU pack mirror skipped", {
      pack: manager.config.name,
      error: error.message,
    });
    return false;
  }
}

function deletedMarker(sharedRoot, manager) {
  return path.join(sharedRoot, `${manager.config.dirName}.deleted`);
}

// The user deleted the pack on purpose: drop the mirror and remember the
// choice, so another channel's copy isn't restored on the next launch either.
function forgetGpuPack(manager, { sharedRoot = defaultSharedRoot(), logger } = {}) {
  try {
    fs.rmSync(path.join(sharedRoot, manager.config.dirName), { recursive: true, force: true });
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.writeFileSync(deletedMarker(sharedRoot, manager), `${new Date().toISOString()}\n`);
  } catch (error) {
    logger?.warn?.("Could not remove GPU pack mirror", {
      pack: manager.config.name,
      error: error.message,
    });
  }
}

/**
 * Restores missing GPU packs from a mirror or a sibling channel, then mirrors
 * every installed pack. Synchronous: it must finish before startup resolves
 * any GPU binary path. A pack whose flag is "false" is left alone.
 * Returns the names of the packs that were restored.
 */
function restoreGpuPacks(
  packs,
  { userDataDir, sharedRoot = defaultSharedRoot(), env = process.env, logger } = {}
) {
  const restored = [];
  for (const { manager, enabledEnvVar } of packs) {
    const assetConfig = manager?._getAssetConfig?.();
    if (!assetConfig) continue;
    if (enabledEnvVar && (env[enabledEnvVar] || "").toLowerCase() === "false") continue;
    if (!isCompletePack(manager.binDir, assetConfig)) {
      if (fs.existsSync(deletedMarker(sharedRoot, manager))) continue;
      const source = candidateSources(manager, { userDataDir, sharedRoot }).find((dir) =>
        isCompletePack(dir, assetConfig)
      );
      if (source) {
        try {
          fs.mkdirSync(path.dirname(manager.binDir), { recursive: true });
          installDir(source, manager.binDir, assetConfig, { allowCopy: true });
          restored.push(manager.config.name);
          logger?.info?.("GPU pack restored", { pack: manager.config.name, from: source });
        } catch (error) {
          logger?.warn?.("GPU pack restore failed", {
            pack: manager.config.name,
            error: error.message,
          });
        }
      }
    }
    mirrorGpuPack(manager, { sharedRoot, logger, fresh: false });
  }
  return restored;
}

module.exports = {
  restoreGpuPacks,
  mirrorGpuPack,
  forgetGpuPack,
  siblingUserDataDirs,
  isCompletePack,
  defaultSharedRoot,
};

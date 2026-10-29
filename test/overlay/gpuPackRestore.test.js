const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let userDataDir = null;
require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => userDataDir } },
};

const restore = require("../../src/helpers/overlay/gpuPackRestore");
const GpuBinaryManager = require("../../src/helpers/gpuBinaryManager");

const ASSET = {
  outputName: "whisper-server-cuda.exe",
  requiredLibraries: ["vcruntime140.dll"],
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "overlay-gpu-"));
}

function fakeManager(userData, dirName = "whisper-cuda", asset = ASSET) {
  return {
    config: { name: `pack ${dirName}`, dirName },
    get binDir() {
      return path.join(userData, "bin", dirName);
    },
    _getAssetConfig: () => asset,
  };
}

function writePack(dir, { complete = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ASSET.outputName), "binary");
  fs.writeFileSync(path.join(dir, "ggml-cuda.dll"), "lib");
  if (complete) fs.writeFileSync(path.join(dir, "vcruntime140.dll"), "msvc");
}

function setup() {
  const root = tmp();
  const appData = path.join(root, "AppData");
  const shared = path.join(root, "cache", "gpu-packs");
  const prod = path.join(appData, "Overlay");
  const dev = path.join(appData, "Overlay-development");
  fs.mkdirSync(prod, { recursive: true });
  fs.mkdirSync(dev, { recursive: true });
  return { root, shared, prod, dev };
}

test("sibling channels of a data folder", () => {
  const dirs = restore.siblingUserDataDirs(path.join("C:", "AppData", "Overlay-development"));
  assert.deepEqual(
    dirs.map((d) => path.basename(d)),
    ["Overlay", "Overlay-staging"]
  );
});

test("a pack downloaded on another channel is restored instead of downloaded again", () => {
  const { shared, prod, dev } = setup();
  writePack(path.join(dev, "bin", "whisper-cuda"));
  const manager = fakeManager(prod);
  const restored = restore.restoreGpuPacks([{ manager, enabledEnvVar: "WHISPER_CUDA_ENABLED" }], {
    userDataDir: prod,
    sharedRoot: shared,
    env: {},
  });
  assert.deepEqual(restored, ["pack whisper-cuda"]);
  assert.ok(restore.isCompletePack(manager.binDir, ASSET));
  assert.equal(fs.readFileSync(path.join(manager.binDir, "ggml-cuda.dll"), "utf8"), "lib");
  // and it is mirrored for the next reinstall
  assert.ok(restore.isCompletePack(path.join(shared, "whisper-cuda"), ASSET));
});

test("a reinstall that wiped the data folder restores from the mirror", () => {
  const { shared, prod } = setup();
  const manager = fakeManager(prod);
  writePack(manager.binDir);
  assert.equal(restore.mirrorGpuPack(manager, { sharedRoot: shared }), true);
  fs.rmSync(path.join(prod, "bin"), { recursive: true, force: true });
  const restored = restore.restoreGpuPacks([{ manager }], {
    userDataDir: prod,
    sharedRoot: shared,
    env: {},
  });
  assert.deepEqual(restored, ["pack whisper-cuda"]);
  assert.ok(restore.isCompletePack(manager.binDir, ASSET));
});

test("the mirror is hard links, not a second copy", () => {
  const { shared, prod } = setup();
  const manager = fakeManager(prod);
  writePack(manager.binDir);
  restore.mirrorGpuPack(manager, { sharedRoot: shared });
  const a = fs.statSync(path.join(manager.binDir, ASSET.outputName));
  const b = fs.statSync(path.join(shared, "whisper-cuda", ASSET.outputName));
  assert.equal(a.ino, b.ino);
});

test("incomplete copies are never restored", () => {
  const { shared, prod, dev } = setup();
  writePack(path.join(dev, "bin", "whisper-cuda"), { complete: false });
  const manager = fakeManager(prod);
  const restored = restore.restoreGpuPacks([{ manager }], {
    userDataDir: prod,
    sharedRoot: shared,
    env: {},
  });
  assert.deepEqual(restored, []);
  assert.equal(fs.existsSync(manager.binDir), false);
});

test("a pack turned off with its flag set to false is left alone", () => {
  const { shared, prod, dev } = setup();
  writePack(path.join(dev, "bin", "whisper-cuda"));
  const manager = fakeManager(prod);
  const restored = restore.restoreGpuPacks([{ manager, enabledEnvVar: "WHISPER_CUDA_ENABLED" }], {
    userDataDir: prod,
    sharedRoot: shared,
    env: { WHISPER_CUDA_ENABLED: "false" },
  });
  assert.deepEqual(restored, []);
});

test("a pack the user deleted stays deleted until downloaded again", () => {
  const { shared, prod, dev } = setup();
  writePack(path.join(dev, "bin", "whisper-cuda"));
  const manager = fakeManager(prod);
  writePack(manager.binDir);
  restore.mirrorGpuPack(manager, { sharedRoot: shared });
  fs.rmSync(manager.binDir, { recursive: true, force: true });
  restore.forgetGpuPack(manager, { sharedRoot: shared });
  assert.equal(fs.existsSync(path.join(shared, "whisper-cuda")), false);

  const opts = { userDataDir: prod, sharedRoot: shared, env: {} };
  assert.deepEqual(restore.restoreGpuPacks([{ manager }], opts), []);
  // the other channel still has its pack, but must not undo the delete
  assert.deepEqual(
    restore.restoreGpuPacks([{ manager: fakeManager(dev) }], { ...opts, userDataDir: dev }),
    []
  );
  assert.deepEqual(restore.restoreGpuPacks([{ manager }], opts), []);

  // a fresh download clears the delete
  writePack(manager.binDir);
  restore.mirrorGpuPack(manager, { sharedRoot: shared });
  fs.rmSync(manager.binDir, { recursive: true, force: true });
  assert.deepEqual(restore.restoreGpuPacks([{ manager }], opts), ["pack whisper-cuda"]);
});

test("an installed pack is untouched and unsupported platforms are skipped", () => {
  const { shared, prod } = setup();
  const manager = fakeManager(prod);
  writePack(manager.binDir);
  const before = fs.statSync(path.join(manager.binDir, ASSET.outputName)).ino;
  const unsupported = fakeManager(prod, "llama-vulkan", null);
  assert.deepEqual(
    restore.restoreGpuPacks([{ manager }, { manager: unsupported }], {
      userDataDir: prod,
      sharedRoot: shared,
      env: {},
    }),
    []
  );
  assert.equal(fs.statSync(path.join(manager.binDir, ASSET.outputName)).ino, before);
});

test("GpuBinaryManager runs no hooks unless startup sets them, and delete reports to them", async () => {
  userDataDir = tmp();
  assert.equal(GpuBinaryManager.packHooks, null);
  const key = `${process.platform}-${process.arch}`;
  const manager = new GpuBinaryManager({
    name: "Test pack",
    dirName: "test-pack",
    assets: { [key]: { outputName: "server.bin" } },
  });
  fs.mkdirSync(manager.binDir, { recursive: true });
  fs.writeFileSync(path.join(manager.binDir, "server.bin"), "x");
  const seen = [];
  GpuBinaryManager.setPackHooks({ onDeleted: (m) => seen.push(m.config.name) });
  try {
    await manager.delete();
  } finally {
    GpuBinaryManager.setPackHooks(null);
  }
  assert.deepEqual(seen, ["Test pack"]);
  assert.equal(fs.existsSync(manager.binDir), false);
});

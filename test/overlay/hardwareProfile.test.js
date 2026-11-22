const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GIB,
  DEFAULT_IDLE_TIMEOUT_MS,
  LOW_MEMORY_IDLE_TIMEOUT_MS,
  detectHardware,
  usableMemoryBytes,
  idleTimeoutMs,
  shouldPrewarmLocalModels,
  parseCimVideoControllers,
  pickPreferredGpu,
} = require("../../src/helpers/overlay/hardwareProfile");

const { clearCache } = require("../../src/utils/gpuDetection");

test.beforeEach(() => clearCache());

const RTX_SMI = "NVIDIA GeForce RTX 4060 Ti, 555.85, 16380, 8.9\n";

function fakeExecFile(handlers) {
  const impl = (file, args, options, callback) => {
    const result = handlers(file, args) || {};
    process.nextTick(() => callback(result.error || null, result.stdout || ""));
  };
  return impl;
}

test("usable memory prefers VRAM when a discrete GPU is present, otherwise a slice of RAM", () => {
  const ram16 = { totalRamBytes: 16 * GIB, vramMb: 0 };
  assert.equal(usableMemoryBytes(ram16), Math.floor(16 * GIB * 0.5));

  const withGpu = { totalRamBytes: 16 * GIB, vramMb: 8192 };
  assert.equal(usableMemoryBytes(withGpu), Math.floor(8192 * 1024 * 1024 * 0.85 + 16 * GIB * 0.25));
});

test("low-RAM machines get a shorter idle timeout and skip model pre-warm", () => {
  assert.equal(idleTimeoutMs({ totalRamBytes: 8 * GIB }), LOW_MEMORY_IDLE_TIMEOUT_MS);
  assert.equal(idleTimeoutMs({ totalRamBytes: 32 * GIB }), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(shouldPrewarmLocalModels({ totalRamBytes: 4 * GIB }), false);
  assert.equal(shouldPrewarmLocalModels({ totalRamBytes: 16 * GIB }), true);
});

test("detectHardware reports CPU, RAM and NVIDIA VRAM", async () => {
  const hw = await detectHardware({
    osImpl: {
      cpus: () => [{}, {}, {}, {}],
      totalmem: () => 16 * GIB,
    },
    execFileImpl: fakeExecFile(() => ({ stdout: RTX_SMI })),
    platform: "win32",
  });
  assert.equal(hw.cpuCores, 4);
  assert.equal(hw.totalRamGiB, 16);
  assert.equal(hw.gpuName, "NVIDIA GeForce RTX 4060 Ti");
  assert.equal(hw.vramMb, 16380);
  assert.equal(hw.gpuSource, "nvidia-smi");
});

test("CIM video-controller rows pick the discrete adapter and its AdapterRAM", () => {
  const gpus = parseCimVideoControllers(
    "Name,AdapterRAM\r\nIntel(R) UHD Graphics 770,1073741824\r\nAMD Radeon RX 7600,8589934592\r\n"
  );
  assert.deepEqual(gpus, [
    { name: "Intel(R) UHD Graphics 770", vramMb: 1024 },
    { name: "AMD Radeon RX 7600", vramMb: 8192 },
  ]);
  assert.deepEqual(pickPreferredGpu(gpus), { name: "AMD Radeon RX 7600", vramMb: 8192 });
});

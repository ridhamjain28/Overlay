const test = require("node:test");
const assert = require("node:assert/strict");

const { GIB } = require("../../src/helpers/overlay/hardwareProfile");
const {
  OVERLAY_DEFAULT_MODEL,
  OVERLAY_FALLBACK_MODEL,
  OVERLAY_TINY_MODEL,
  estimateParamsB,
  estimateModelMemoryBytes,
  modelFits,
  recommendPull,
  selectLocalModel,
} = require("../../src/helpers/overlay/modelAutoSelect");

const lowRam = { totalRamBytes: 4 * GIB, vramMb: 0 };
const ram8 = { totalRamBytes: 8 * GIB, vramMb: 0 };
const ram16 = { totalRamBytes: 16 * GIB, vramMb: 0 };
const ram32Gpu = { totalRamBytes: 32 * GIB, vramMb: 16384 };

test("parameter counts and memory estimates grow with model size", () => {
  assert.equal(estimateParamsB(OVERLAY_TINY_MODEL), 1.5);
  assert.equal(estimateParamsB(OVERLAY_DEFAULT_MODEL), 4);
  assert.equal(estimateParamsB("qwen2.5:7b"), 7);
  assert.ok(
    estimateModelMemoryBytes(OVERLAY_TINY_MODEL) < estimateModelMemoryBytes(OVERLAY_DEFAULT_MODEL)
  );
  assert.ok(estimateModelMemoryBytes("qwen2.5:7b") < estimateModelMemoryBytes("qwen2.5:14b"));
});

test("a 4 GB CPU-only machine fits the tiny model and not a 7B", () => {
  assert.equal(modelFits(OVERLAY_TINY_MODEL, lowRam), true);
  assert.equal(modelFits("qwen2.5:7b", lowRam), false);
  assert.equal(recommendPull(lowRam), OVERLAY_TINY_MODEL);
});

test("16 GB of RAM can pull the default 4B; a 16 GB GPU can hold a 7B", () => {
  assert.equal(recommendPull(ram16), OVERLAY_DEFAULT_MODEL);
  assert.equal(modelFits("qwen2.5:7b", ram32Gpu), true);
});

test("auto-select picks the largest installed model that fits", () => {
  const picked = selectLocalModel({
    installed: [OVERLAY_TINY_MODEL, "qwen2.5:7b", OVERLAY_DEFAULT_MODEL],
    hardware: ram8,
    current: OVERLAY_DEFAULT_MODEL,
    autoSelect: true,
  });
  assert.equal(picked.reason, "auto-keep");
  // 7B does not comfortably fit 8 GB CPU-only; keep the current 4B.
  assert.equal(picked.model, OVERLAY_DEFAULT_MODEL);
  assert.equal(picked.fits, true);

  const withGpu = selectLocalModel({
    installed: [OVERLAY_TINY_MODEL, "qwen2.5:7b", OVERLAY_DEFAULT_MODEL],
    hardware: ram32Gpu,
    current: OVERLAY_DEFAULT_MODEL,
    autoSelect: true,
  });
  assert.equal(withGpu.model, "qwen2.5:7b");
  assert.equal(withGpu.reason, "auto-select");
});

test("auto keeps the current 4B tag when nothing larger fits", () => {
  const picked = selectLocalModel({
    installed: [OVERLAY_FALLBACK_MODEL, OVERLAY_DEFAULT_MODEL],
    hardware: ram16,
    current: OVERLAY_DEFAULT_MODEL,
    autoSelect: true,
  });
  assert.equal(picked.model, OVERLAY_DEFAULT_MODEL);
  assert.equal(picked.reason, "auto-keep");
});

test("a manual override is kept when it fits, and refused when it does not", () => {
  const kept = selectLocalModel({
    installed: [OVERLAY_TINY_MODEL, "qwen2.5:7b"],
    hardware: ram32Gpu,
    current: OVERLAY_TINY_MODEL,
    autoSelect: false,
  });
  assert.equal(kept.model, OVERLAY_TINY_MODEL);
  assert.equal(kept.reason, "manual-override");

  const refused = selectLocalModel({
    installed: [OVERLAY_TINY_MODEL, "qwen2.5:7b"],
    hardware: lowRam,
    current: "qwen2.5:7b",
    autoSelect: false,
  });
  assert.equal(refused.model, OVERLAY_TINY_MODEL);
  assert.equal(refused.reason, "override-too-large");
  assert.equal(refused.fits, true);
});

test("when nothing installed fits, auto returns no model and a tiny pull recommendation", () => {
  const picked = selectLocalModel({
    installed: ["llama3:70b"],
    hardware: lowRam,
    current: "llama3:70b",
    autoSelect: true,
  });
  assert.equal(picked.model, null);
  assert.equal(picked.reason, "none-fit");
  assert.equal(picked.recommendedPull, OVERLAY_TINY_MODEL);
});

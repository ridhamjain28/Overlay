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
const rtx5060 = { totalRamBytes: 16 * GIB, vramMb: 8192 };
const ram32Gpu = { totalRamBytes: 32 * GIB, vramMb: 16384 };

test("parameter counts and memory estimates grow with model size", () => {
  assert.equal(estimateParamsB(OVERLAY_TINY_MODEL), 4);
  assert.equal(estimateParamsB(OVERLAY_DEFAULT_MODEL), 8);
  assert.equal(estimateParamsB("qwen3:14b"), 14);
  assert.ok(
    estimateModelMemoryBytes(OVERLAY_TINY_MODEL) < estimateModelMemoryBytes(OVERLAY_DEFAULT_MODEL)
  );
  assert.ok(estimateModelMemoryBytes("qwen3:8b") < estimateModelMemoryBytes("qwen3:14b"));
});

test("an 8 GB CPU-only machine fits the 4B instruct model and not 8B", () => {
  assert.equal(modelFits(OVERLAY_TINY_MODEL, ram8), true);
  assert.equal(modelFits(OVERLAY_DEFAULT_MODEL, ram8), false);
  assert.equal(recommendPull(ram8), OVERLAY_TINY_MODEL);
});

test("an 8 GB VRAM GPU (RTX 5060) and 16 GB RAM can pull and fit qwen3:8b; 16 GB GPU holds 14B", () => {
  assert.equal(recommendPull(rtx5060), OVERLAY_DEFAULT_MODEL);
  assert.equal(modelFits(OVERLAY_DEFAULT_MODEL, rtx5060), true);
  assert.equal(recommendPull(ram16), OVERLAY_DEFAULT_MODEL);
  assert.equal(modelFits("qwen3:14b", ram32Gpu), true);
});

test("auto-select picks the largest installed model that fits when fast instruct is absent", () => {
  const picked = selectLocalModel({
    installed: ["qwen3:1.7b", "qwen3:14b", OVERLAY_DEFAULT_MODEL],
    hardware: ram8,
    current: "qwen3:1.7b",
    autoSelect: true,
  });
  assert.equal(picked.reason, "auto-keep");
  // 8B does not comfortably fit 8 GB CPU-only; keep the current 1.7B.
  assert.equal(picked.model, "qwen3:1.7b");
  assert.equal(picked.fits, true);

  const withGpu = selectLocalModel({
    installed: ["qwen3:1.7b", "qwen3:14b", OVERLAY_DEFAULT_MODEL],
    hardware: ram32Gpu,
    current: OVERLAY_DEFAULT_MODEL,
    autoSelect: true,
  });
  assert.equal(withGpu.model, "qwen3:14b");
  assert.equal(withGpu.reason, "auto-select");
});

test("auto keeps the current 8B tag when nothing larger fits", () => {
  const picked = selectLocalModel({
    installed: [OVERLAY_DEFAULT_MODEL, "qwen3:1.7b"],
    hardware: rtx5060,
    current: OVERLAY_DEFAULT_MODEL,
    autoSelect: true,
  });
  assert.equal(picked.model, OVERLAY_DEFAULT_MODEL);
  assert.equal(picked.reason, "auto-keep");
});

test("auto prefers the fast instruct model over larger installed ones", () => {
  const picked = selectLocalModel({
    installed: [OVERLAY_FALLBACK_MODEL, OVERLAY_DEFAULT_MODEL, "qwen3:14b"],
    hardware: ram32Gpu,
    current: OVERLAY_DEFAULT_MODEL,
    autoSelect: true,
  });
  assert.equal(picked.model, OVERLAY_FALLBACK_MODEL);
  assert.equal(picked.reason, "auto-fast");
  // A manual pick still wins when auto-select is off.
  const manual = selectLocalModel({
    installed: [OVERLAY_FALLBACK_MODEL, "qwen3:14b"],
    hardware: ram32Gpu,
    current: "qwen3:14b",
    autoSelect: false,
  });
  assert.equal(manual.model, "qwen3:14b");
});

test("a manual override is kept when it fits, and refused when it does not", () => {
  const kept = selectLocalModel({
    installed: [OVERLAY_TINY_MODEL, "qwen3:14b"],
    hardware: ram32Gpu,
    current: OVERLAY_TINY_MODEL,
    autoSelect: false,
  });
  assert.equal(kept.model, OVERLAY_TINY_MODEL);
  assert.equal(kept.reason, "manual-override");

  const refused = selectLocalModel({
    installed: [OVERLAY_TINY_MODEL, "qwen3:14b"],
    hardware: ram8,
    current: "qwen3:14b",
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

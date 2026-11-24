/**
 * Pick a local Ollama model that fits this machine.
 *
 * "auto" prefers the fast instruct model (qwen3:4b-instruct) when it is installed
 * and fits, since dictation and Command mode are latency-bound; otherwise it
 * chooses the largest installed model that comfortably fits RAM/VRAM.
 * A manual override keeps the user's choice when it fits, and never loads a
 * model larger than the machine can hold — it falls back instead.
 */

// Same rule as src/utils/modelSize.ts, inlined so this file loads in Electron
// without a TypeScript loader and in the renderer without Node built-ins.
function estimateModelSizeB(modelId) {
  const match = String(modelId || "").match(/[-:_/](\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/);
  return match ? parseFloat(match[1]) : 0;
}

const GIB = 1024 * 1024 * 1024;

// Duplicated from hardwareProfile.js so this module stays renderer-safe
// (no os / child_process / nvidia-smi).
function usableMemoryBytes(hardware) {
  const ram = Number(hardware?.totalRamBytes) || 0;
  const vram = (Number(hardware?.vramMb) || 0) * 1024 * 1024;
  if (vram >= 2 * GIB) {
    return Math.floor(vram * 0.85 + ram * 0.25);
  }
  return Math.floor(ram * 0.5);
}

const OVERLAY_DEFAULT_MODEL = "qwen3:8b";
const OVERLAY_FALLBACK_MODEL = "qwen3:4b-instruct";
const OVERLAY_TINY_MODEL = "qwen3:4b-instruct";

// The models Overlay is willing to recommend pulling, smallest first.
const PULL_CATALOG = Object.freeze([
  OVERLAY_TINY_MODEL,
  OVERLAY_FALLBACK_MODEL,
  OVERLAY_DEFAULT_MODEL,
]);

const DEFAULT_CONTEXT_TOKENS = 8192;

function sameModel(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const strip = (name) => name.trim().replace(/:latest$/, "");
  return strip(a).toLowerCase() === strip(b).toLowerCase();
}

function hasModel(installed, wanted) {
  if (!wanted || !Array.isArray(installed)) return false;
  return installed.some((name) => sameModel(name, wanted));
}

function installedName(installed, wanted) {
  if (!wanted || !Array.isArray(installed)) return wanted;
  return installed.find((name) => sameModel(name, wanted)) || wanted;
}

function bitsPerParam(modelId) {
  const tag = String(modelId || "").toLowerCase();
  if (/\bfp32\b|\bf32\b/.test(tag)) return 32;
  if (/\bfp16\b|\bf16\b|\bbf16\b/.test(tag)) return 16;
  if (/\bq8/.test(tag)) return 8.5;
  if (/\bq6/.test(tag)) return 6.5;
  if (/\bq5/.test(tag)) return 5.5;
  if (/\bq3/.test(tag)) return 3.5;
  if (/\bq2/.test(tag)) return 2.6;
  // Ollama's default (and Overlay's shipped 4-bit tags) land around 4.5 bits.
  return 4.5;
}

function estimateParamsB(modelId) {
  const fromTag = estimateModelSizeB(modelId || "");
  return fromTag > 0 ? fromTag : 0;
}

/**
 * Weights plus a rough KV-cache and runtime overhead for `contextTokens`.
 * Unknown tags are treated as a 7B Q4 so we never assume a mystery model is tiny.
 */
function estimateModelMemoryBytes(modelId, contextTokens = DEFAULT_CONTEXT_TOKENS) {
  const paramsB = estimateParamsB(modelId) || 7;
  const bits = estimateParamsB(modelId) ? bitsPerParam(modelId) : 4.5;
  const ctx =
    Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS;
  const weightBytes = paramsB * 1e9 * (bits / 8);
  const kvBytes = paramsB * 0.12 * GIB * (ctx / 4096);
  const overhead = weightBytes * 0.15;
  return Math.ceil(weightBytes + kvBytes + overhead);
}

function modelFits(modelId, hardware, contextTokens = DEFAULT_CONTEXT_TOKENS) {
  const usable = usableMemoryBytes(hardware);
  if (usable <= 0) return false;
  return estimateModelMemoryBytes(modelId, contextTokens) + 256 * 1024 * 1024 <= usable;
}

function compareModels(a, b, contextTokens) {
  const paramsDiff = (estimateParamsB(b) || 0) - (estimateParamsB(a) || 0);
  if (paramsDiff) return paramsDiff;
  return estimateModelMemoryBytes(b, contextTokens) - estimateModelMemoryBytes(a, contextTokens);
}

function recommendPull(hardware, contextTokens = DEFAULT_CONTEXT_TOKENS) {
  let best = OVERLAY_TINY_MODEL;
  for (const id of PULL_CATALOG) {
    if (modelFits(id, hardware, contextTokens)) best = id;
  }
  return best;
}

function largestFitting(installed, hardware, contextTokens) {
  const fitting = (installed || []).filter((name) => modelFits(name, hardware, contextTokens));
  if (!fitting.length) return null;
  fitting.sort((a, b) => compareModels(a, b, contextTokens));
  return fitting[0];
}

/**
 * @param {object} opts
 * @param {string[] | null | undefined} opts.installed  tags Ollama reports
 * @param {object} opts.hardware  from detectHardware()
 * @param {string} [opts.current]  the model the user (or defaults) currently has
 * @param {boolean} [opts.autoSelect=true]
 * @param {number} [opts.contextTokens]
 * @returns {{
 *   model: string | null,
 *   reason: string,
 *   fits: boolean,
 *   usableMemoryBytes: number,
 *   estimatedBytes: number | null,
 *   recommendedPull: string,
 * }}
 */
function selectLocalModel({
  installed,
  hardware,
  current,
  autoSelect = true,
  contextTokens = DEFAULT_CONTEXT_TOKENS,
} = {}) {
  const usable = usableMemoryBytes(hardware);
  const recommendedPull = recommendPull(hardware, contextTokens);
  const names = Array.isArray(installed) ? installed.filter(Boolean) : [];
  const currentInstalled =
    current && hasModel(names, current) ? installedName(names, current) : null;
  const currentFits = currentInstalled
    ? modelFits(currentInstalled, hardware, contextTokens)
    : false;
  const largest = largestFitting(names, hardware, contextTokens);

  const result = (model, reason, fits) => ({
    model,
    reason,
    fits: !!fits,
    usableMemoryBytes: usable,
    estimatedBytes: model ? estimateModelMemoryBytes(model, contextTokens) : null,
    recommendedPull,
  });

  // Manual override: keep the choice when it fits. If it does not, never load it.
  if (!autoSelect) {
    if (currentInstalled && currentFits) {
      return result(currentInstalled, "manual-override", true);
    }
    if (current && !currentFits) {
      if (largest) return result(largest, "override-too-large", true);
      return result(null, "override-too-large", false);
    }
    if (largest) return result(largest, "override-missing", true);
    return result(current || null, "override-missing", false);
  }

  // Auto: the fast instruct model wins whenever it is installed and fits.
  const fast = hasModel(names, OVERLAY_FALLBACK_MODEL)
    ? installedName(names, OVERLAY_FALLBACK_MODEL)
    : null;
  if (fast && modelFits(fast, hardware, contextTokens)) {
    return result(fast, sameModel(fast, current) ? "auto-keep" : "auto-fast", true);
  }

  // Auto: largest installed model that fits, preferring the current one when
  // it is already that size (so we don't flap between equal 4B tags).
  if (largest) {
    if (
      currentInstalled &&
      currentFits &&
      (estimateParamsB(currentInstalled) || 0) >= (estimateParamsB(largest) || 0)
    ) {
      return result(currentInstalled, "auto-keep", true);
    }
    return result(largest, "auto-select", true);
  }

  return result(null, "none-fit", false);
}

module.exports = {
  OVERLAY_DEFAULT_MODEL,
  OVERLAY_FALLBACK_MODEL,
  OVERLAY_TINY_MODEL,
  PULL_CATALOG,
  DEFAULT_CONTEXT_TOKENS,
  sameModel,
  hasModel,
  bitsPerParam,
  estimateParamsB,
  estimateModelMemoryBytes,
  modelFits,
  recommendPull,
  selectLocalModel,
};

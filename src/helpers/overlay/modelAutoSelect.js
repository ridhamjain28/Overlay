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
  const id = String(modelId || "");
  const moeMatch = id.match(/(?:^|[-:_/\s])(\d+)\s*[xX]\s*(\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/);
  if (moeMatch) {
    return parseFloat(moeMatch[1]) * parseFloat(moeMatch[2]);
  }
  const matchB = id.match(/(?:^|[-:_/\s])(\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/);
  if (matchB) return parseFloat(matchB[1]);
  const matchM = id.match(/(?:^|[-:_/\s])(\d+(?:\.\d+)?)[mM](?![a-zA-Z0-9])/);
  return matchM ? parseFloat(matchM[1]) / 1000 : 0;
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
  if (/(?:^|[^a-z0-9])(fp32|f32)(?![a-z0-9])/.test(tag)) return 32;
  if (/(?:^|[^a-z0-9])(fp16|f16|bf16)(?![a-z0-9])/.test(tag)) return 16;
  if (/(?:^|[^a-z0-9])q8/.test(tag)) return 8.5;
  if (/(?:^|[^a-z0-9])q6/.test(tag)) return 6.5;
  if (/(?:^|[^a-z0-9])q5/.test(tag)) return 5.5;
  if (/(?:^|[^a-z0-9])(q3|iq3)/.test(tag)) return 3.5;
  if (/(?:^|[^a-z0-9])(q2|iq2)/.test(tag)) return 2.6;
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
  const names = Array.isArray(installed)
    ? installed.filter((n) => typeof n === "string" && n.trim().length > 0)
    : [];
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
    if (currentInstalled && !currentFits) {
      if (largest) return result(largest, "override-too-large", true);
      return result(null, "override-too-large", false);
    }
    if (current && !modelFits(current, hardware, contextTokens)) {
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

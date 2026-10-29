/**
 * How much of a conversation the local model may keep in view.
 *
 * Chat used to start llama-server at the fixed 16384 baseline and never grow
 * it, and Ollama's /v1 endpoint silently ignores num_ctx, so a long chat lost
 * its beginning without any error. This picks a larger, machine-sized window
 * for the bundled server, tells Ollama the same size when Overlay starts it,
 * and reads back the window Ollama actually loaded so the renderer can fit
 * the conversation into it instead of overflowing.
 */

const GIB = 1024 * 1024 * 1024;

// Plain choices the settings screen offers. "auto" sizes by system memory.
const CHAT_CONTEXT_CHOICES = Object.freeze({
  standard: 8192,
  long: 16384,
  "extra-long": 32768,
  max: 65536,
});

const CHAT_CONTEXT_SETTINGS = Object.freeze(["auto", ...Object.keys(CHAT_CONTEXT_CHOICES)]);

// Ollama's own default when it reports nothing, so the budget errs small.
const OLLAMA_FALLBACK_CONTEXT = 4096;

// The latest choice from settings, pushed by the renderer at start and on change.
let currentSetting = "auto";
function setChatContextSetting(value) {
  currentSetting = normalizeChatContextSetting(value);
}
function getChatContextSetting() {
  return currentSetting;
}

function normalizeChatContextSetting(value) {
  return CHAT_CONTEXT_SETTINGS.includes(value) ? value : "auto";
}

function autoChatContext(totalMemoryBytes) {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return 16384;
  const gib = totalMemoryBytes / GIB;
  if (gib < 12) return 8192;
  if (gib < 24) return 16384;
  if (gib < 48) return 32768;
  return 65536;
}

/** The window chat asks for, before the per-model memory ceiling applies. */
function chatContextTarget(setting, totalMemoryBytes) {
  const choice = CHAT_CONTEXT_CHOICES[normalizeChatContextSetting(setting)];
  return choice || autoChatContext(totalMemoryBytes);
}

/**
 * The bundled server never starts below the baseline (dictation and every
 * other caller rely on it) and never above what this machine can hold for
 * this model.
 */
function llamaChatContextSize({ target, ceiling, baseline }) {
  const safeCeiling = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : baseline;
  return Math.max(baseline, Math.min(target, safeCeiling));
}

function ollamaNativeBase(url) {
  const raw = typeof url === "string" && url.trim() ? url.trim() : "http://127.0.0.1:11434";
  return raw.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
}

function sameModel(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const strip = (name) => name.replace(/:latest$/, "");
  return strip(a) === strip(b);
}

async function getJson(fetchImpl, url, init, timeoutMs) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  return res.json();
}

/**
 * The window Ollama loaded this model with, or the model's trained maximum
 * capped by the Ollama default when it is not loaded yet. Null when the
 * server is not Ollama (or not reachable).
 */
async function ollamaLoadedContext({
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
} = {}) {
  if (typeof fetchImpl !== "function") return null;
  const base = ollamaNativeBase(baseUrl);
  let ps;
  try {
    ps = await getJson(fetchImpl, `${base}/api/ps`, {}, timeoutMs);
  } catch {
    return null;
  }
  if (!ps || !Array.isArray(ps.models)) return null;
  const loaded = ps.models.find((m) => sameModel(m?.name, model) || sameModel(m?.model, model));
  const loadedContext = Number(loaded?.context_length);
  if (Number.isFinite(loadedContext) && loadedContext > 0) return loadedContext;
  return OLLAMA_FALLBACK_CONTEXT;
}

module.exports = {
  CHAT_CONTEXT_CHOICES,
  CHAT_CONTEXT_SETTINGS,
  OLLAMA_FALLBACK_CONTEXT,
  normalizeChatContextSetting,
  setChatContextSetting,
  getChatContextSetting,
  autoChatContext,
  chatContextTarget,
  llamaChatContextSize,
  ollamaNativeBase,
  ollamaLoadedContext,
};

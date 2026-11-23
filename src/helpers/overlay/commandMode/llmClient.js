// Overlay Command mode: one-shot JSON completion for intent parsing.
// Local by default (loopback Ollama / llama-server). Cloud is optional and
// uses keys already in the main-process environment — never logged.

const { INTENT_JSON_SCHEMA, commandSkillSystemPrompt } = require("./skillLoader");

const DEFAULT_LOCAL_BASE = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_NATIVE_BASE = "http://127.0.0.1:11434";
const DEFAULT_LOCAL_MODEL = "qwen3.5:4b-q4_K_M";
const PREFERRED_LOCAL_PARSE_MODEL = "qwen3:4b-instruct";
const TIMEOUT_MS = 20000;
const LOCAL_TIMEOUT_MS = 45000;
const PARSE_MAX_TOKENS = 400;
const PARSE_NUM_CTX = 8192;
const PARSE_KEEP_ALIVE = -1;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value, fallback = DEFAULT_LOCAL_BASE) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return fallback;
  const base = raw.replace(/\/chat\/completions$/i, "").replace(/\/v1$/i, "") + "/v1";
  return base;
}

function nativeOllamaBase(value, fallback = DEFAULT_LOCAL_NATIVE_BASE) {
  const raw = String(value || fallback).trim();
  try {
    const url = new URL(raw);
    if (!LOOPBACK.has(url.hostname)) return fallback;
    return `${url.protocol}//${url.host}`;
  } catch {
    return fallback;
  }
}

function firstEnv(env, names) {
  for (const name of names) {
    const v = env[name];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function isThinkingModel(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  if (/\binstruct\b/.test(n) || n.includes("instruct")) return false;
  if (/qwen3\.5/.test(n)) return true;
  if (/thinking|reason/.test(n)) return true;
  return false;
}

function installedModelNames(installed = []) {
  return installed
    .map((item) => (typeof item === "string" ? item : item?.name || item?.model || ""))
    .map((name) => String(name || "").trim())
    .filter(Boolean);
}

function findInstalledModel(installed, wanted) {
  const names = installedModelNames(installed);
  const exact = names.find((name) => name === wanted);
  if (exact) return exact;
  const prefix = names.find((name) => name === wanted || name.startsWith(`${wanted}-`) || name.startsWith(`${wanted}:`));
  return prefix || null;
}

/**
 * Prefer an installed non-thinking instruct model when the chat model is a
 * thinking model (for example qwen3.5). Otherwise use the chat model.
 */
function pickLocalParseModel(chatModel, installed = []) {
  const chat = String(chatModel || "").trim();
  if (chat && !isThinkingModel(chat)) return chat;
  const preferred = findInstalledModel(installed, PREFERRED_LOCAL_PARSE_MODEL);
  if (preferred) return preferred;
  const instruct = installedModelNames(installed).find((name) => /instruct/i.test(name));
  if (instruct) return instruct;
  return chat || DEFAULT_LOCAL_MODEL;
}

function timeoutError() {
  const err = new Error("Intent parser timed out");
  err.code = "TIMEOUT";
  err.name = "AbortError";
  return err;
}

function wrapAbort(error) {
  if (error && (error.name === "AbortError" || error.code === "TIMEOUT")) {
    return timeoutError();
  }
  return error;
}

function cloudConfig(provider, env = process.env) {
  const p = String(provider || "").toLowerCase();
  if (p === "openrouter") {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: firstEnv(env, ["OPENROUTER_API_KEY"]),
      model: firstEnv(env, ["OPENROUTER_MODEL"]) || "openrouter/auto",
      headers: { "HTTP-Referer": "https://overlay.local", "X-Title": "Overlay" },
    };
  }
  if (p === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      key: firstEnv(env, ["OPENAI_API_KEY"]),
      model: firstEnv(env, ["OPENAI_MODEL"]) || "gpt-4o-mini",
    };
  }
  if (p === "groq") {
    return {
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: firstEnv(env, ["GROQ_API_KEY"]),
      model: firstEnv(env, ["GROQ_MODEL"]) || "llama-3.1-8b-instant",
    };
  }
  if (p === "gemini" || p === "google") {
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: firstEnv(env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
      model: firstEnv(env, ["GEMINI_MODEL"]) || "gemini-2.0-flash",
    };
  }
  if (p === "mistral") {
    return {
      url: "https://api.mistral.ai/v1/chat/completions",
      key: firstEnv(env, ["MISTRAL_API_KEY"]),
      model: firstEnv(env, ["MISTRAL_MODEL"]) || "mistral-small-latest",
    };
  }
  // Unspecified: first configured cloud key wins.
  const order = ["openrouter", "gemini", "groq", "openai", "mistral"];
  for (const name of order) {
    const cfg = cloudConfig(name, env);
    if (cfg.key) return { ...cfg, provider: name };
  }
  return { url: "", key: "", model: "", provider: p || "" };
}

function contentFromOpenAiMessage(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.type === "text" ? part.text : "")).join("\n");
  }
  return "";
}


function messagesFromPrompt(prompt) {
  if (prompt && typeof prompt === "object") {
    return {
      system: prompt.system || commandSkillSystemPrompt(),
      user: String(prompt.user || prompt.prompt || ""),
    };
  }
  return { system: commandSkillSystemPrompt(), user: String(prompt || "") };
}

async function completeChat({ url, key, model, prompt, fetchImpl, signal, headers = {} }) {
  const { system, user } = messagesFromPrompt(prompt);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: PARSE_MAX_TOKENS,
      reasoning_effort: "none",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    const err = new Error(`Intent parser HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const json = await response.json();
  return contentFromOpenAiMessage(json?.choices?.[0]?.message?.content);
}

async function listInstalledModels(fetchImpl, nativeBase, signal) {
  try {
    const response = await fetchImpl(`${nativeBase}/api/tags`, { method: "GET", signal });
    if (!response.ok) return [];
    const json = await response.json();
    const models = Array.isArray(json?.models) ? json.models : [];
    return installedModelNames(models);
  } catch {
    return [];
  }
}

async function completeNativeChat({ url, model, prompt, fetchImpl, signal }) {
  const { system, user } = messagesFromPrompt(prompt);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: PARSE_KEEP_ALIVE,
      format: INTENT_JSON_SCHEMA,
      options: {
        temperature: 0,
        num_ctx: PARSE_NUM_CTX,
        num_predict: PARSE_MAX_TOKENS,
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    const err = new Error(`Intent parser HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const json = await response.json();
  const content = json?.message?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") return contentFromOpenAiMessage(content);
  return contentFromOpenAiMessage(json?.choices?.[0]?.message?.content);
}

/**
 * Build an `llmComplete(prompt) => string` function.
 * parser: "local" | "cloud"
 * Local base URLs that are not loopback are refused.
 */
function createIntentCompleter(opts = {}) {
  const {
    parser = "local",
    model,
    localBaseUrl,
    cloudProvider,
    env = process.env,
    fetchImpl = fetch,
    timeoutMs,
  } = opts;

  return async function llmComplete(prompt) {
    const defaultTimeout = parser === "cloud" ? TIMEOUT_MS : LOCAL_TIMEOUT_MS;
    const usedTimeout = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), usedTimeout) : null;
    try {
      if (parser === "cloud") {
        const cloud = cloudConfig(cloudProvider, env);
        if (!cloud.key || !cloud.url) {
          throw new Error("No cloud API key is configured for Command mode");
        }
        return await completeChat({
          url: cloud.url,
          key: cloud.key,
          model: model || cloud.model,
          prompt,
          fetchImpl,
          signal: controller?.signal,
          headers: cloud.headers || {},
        });
      }

      const base = normalizeBaseUrl(localBaseUrl, DEFAULT_LOCAL_BASE);
      if (!isLoopbackUrl(base) || !isLoopbackUrl(localBaseUrl || base)) {
        throw new Error("Local Command mode can only call a model on this computer");
      }
      const nativeBase = nativeOllamaBase(localBaseUrl || base);
      const installed = await listInstalledModels(fetchImpl, nativeBase, controller?.signal);
      const chosen = pickLocalParseModel(model || DEFAULT_LOCAL_MODEL, installed);
      try {
        return await completeNativeChat({
          url: `${nativeBase}/api/chat`,
          model: chosen,
          prompt,
          fetchImpl,
          signal: controller?.signal,
        });
      } catch (error) {
        if (error?.status === 404) {
          return await completeChat({
            url: `${base}/chat/completions`,
            key: "",
            model: chosen,
            prompt,
            fetchImpl,
            signal: controller?.signal,
          });
        }
        throw error;
      }
    } catch (error) {
      throw wrapAbort(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

module.exports = {
  DEFAULT_LOCAL_BASE,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_NATIVE_BASE,
  PREFERRED_LOCAL_PARSE_MODEL,
  TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  PARSE_MAX_TOKENS,
  PARSE_NUM_CTX,
  PARSE_KEEP_ALIVE,
  isLoopbackUrl,
  normalizeBaseUrl,
  nativeOllamaBase,
  isThinkingModel,
  pickLocalParseModel,
  cloudConfig,
  createIntentCompleter,
  INTENT_JSON_SCHEMA,
};
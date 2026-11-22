// Overlay Command mode: one-shot JSON completion for intent parsing.
// Local by default (loopback Ollama / llama-server). Cloud is optional and
// uses keys already in the main-process environment — never logged.

const DEFAULT_LOCAL_BASE = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_MODEL = "qwen3.5:4b-q4_K_M";
const TIMEOUT_MS = 20000;
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

function firstEnv(env, names) {
  for (const name of names) {
    const v = env[name];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
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

async function completeChat({ url, key, model, prompt, fetchImpl, signal, headers = {} }) {
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
      messages: [
        {
          role: "system",
          content: "Return only valid JSON for the user's request. No markdown.",
        },
        { role: "user", content: prompt },
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
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.type === "text" ? part.text : "")).join("\n");
  }
  return "";
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
    timeoutMs = TIMEOUT_MS,
  } = opts;

  return async function llmComplete(prompt) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
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
      if (!isLoopbackUrl(base)) {
        throw new Error("Local Command mode can only call a model on this computer");
      }
      return await completeChat({
        url: `${base}/chat/completions`,
        key: "",
        model: model || DEFAULT_LOCAL_MODEL,
        prompt,
        fetchImpl,
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

module.exports = {
  DEFAULT_LOCAL_BASE,
  DEFAULT_LOCAL_MODEL,
  isLoopbackUrl,
  normalizeBaseUrl,
  cloudConfig,
  createIntentCompleter,
};

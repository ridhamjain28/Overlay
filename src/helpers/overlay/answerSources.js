// Overlay: remote "answer sources" that run in the main process, so their
// tokens never reach the renderer, a log, or the repo.
//
//   openclaw – your own OpenClaw gateway (OpenAI-compatible /v1/chat/completions,
//              streamed with SSE). Token: OPENCLAW_TOKEN (env or userData .env).
//   gemini   – Gemini API with Google Search grounding (GEMINI_API_KEY).
//
// The local Ollama source is not here: the renderer already streams it through
// the app's normal self-hosted path (with tools).

const {
  GEMINI_API_BASE,
  DEFAULT_GEMINI_SEARCH_MODEL,
  getSearchConfig,
  getOllamaDailyCap,
  getDefaultSearchCounter,
} = require("./webSearch");

const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:18789/v1";
const DEFAULT_OPENCLAW_MODEL = "openclaw/default";
const PROBE_TIMEOUT_MS = 1500;
const PROBE_CACHE_MS = 20000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function getOpenClawConfig(env = process.env) {
  const rawUrl = (env.OPENCLAW_URL || DEFAULT_OPENCLAW_URL).trim().replace(/\/+$/, "");
  // Accept a full .../chat/completions URL too.
  const baseUrl = rawUrl.replace(/\/chat\/completions$/, "");
  let loopback = false;
  try {
    loopback = LOOPBACK_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    loopback = false;
  }
  const token = (env.OPENCLAW_TOKEN || "").trim();
  return {
    baseUrl,
    model: (env.OPENCLAW_MODEL || "").trim() || DEFAULT_OPENCLAW_MODEL,
    token,
    loopback,
    // The gateway token is full access to your machine: only talk to it on
    // loopback unless the user explicitly opts in.
    allowed: loopback || env.OVERLAY_ALLOW_REMOTE_OPENCLAW === "1",
    configured: Boolean(token),
  };
}

/** Reads Server-Sent Events from a fetch Response body; yields each `data:` payload. */
async function* readSseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    buffer += decoder.decode();
    const rest = buffer.replace(/\r$/, "");
    if (rest.startsWith("data:")) yield rest.slice(5).trimStart();
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function toTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && part.type === "text" && typeof part.text === "string" ? part.text : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Plain {role, content:string} messages; drops tool traces and images. */
function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && ["system", "user", "assistant"].includes(m.role))
    .map((m) => ({ role: m.role, content: toTextContent(m.content) }))
    .filter((m) => m.content.trim());
}

async function errorFromResponse(response, label) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message || json?.message || "";
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {}
  const error = new Error(
    `${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
  );
  error.status = response.status;
  return error;
}

async function* streamOpenClaw({ messages, user, signal, env = process.env, fetchImpl = fetch }) {
  const config = getOpenClawConfig(env);
  if (!config.configured) throw new Error("OpenClaw is not set up: OPENCLAW_TOKEN is missing.");
  if (!config.allowed) {
    throw new Error("OpenClaw URL is not on this computer (loopback). Refusing to send the token.");
  }
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: normalizeMessages(messages),
      stream: true,
      ...(user ? { user: String(user).slice(0, 128) } : {}),
    }),
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response, "OpenClaw");
  if (!response.body) throw new Error("OpenClaw returned an empty response.");
  for await (const data of readSseData(response.body)) {
    if (data === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json?.error) throw new Error(`OpenClaw: ${json.error.message || "stream error"}`);
    const text = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
    if (typeof text === "string" && text) yield text;
  }
}

function toGeminiRequest(messages) {
  const normalized = normalizeMessages(messages);
  const system = normalized
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = normalized
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    tools: [{ google_search: {} }],
  };
}

function formatSources(chunks) {
  const seen = new Set();
  const lines = [];
  for (const chunk of chunks || []) {
    const uri = chunk?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    lines.push(`- [${chunk.web.title || "source"}](${uri})`);
    if (lines.length >= 5) break;
  }
  return lines.length ? `\n\nSources:\n${lines.join("\n")}` : "";
}

async function* streamGemini({ messages, signal, env = process.env, fetchImpl = fetch }) {
  const { geminiKey, geminiModel } = getSearchConfig(env);
  if (!geminiKey) {
    throw new Error("Gemini is not set up: add GEMINI_API_KEY in Settings → API Keys.");
  }
  const model = geminiModel || DEFAULT_GEMINI_SEARCH_MODEL;
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify(toGeminiRequest(messages)),
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response, "Gemini");
  if (!response.body) throw new Error("Gemini returned an empty response.");
  let groundingChunks = [];
  for await (const data of readSseData(response.body)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const candidate = json?.candidates?.[0];
    const text = (candidate?.content?.parts || [])
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    if (text) yield text;
    const chunks = candidate?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks) && chunks.length) groundingChunks = chunks;
  }
  const sources = formatSources(groundingChunks);
  if (sources) yield sources;
}

const probeCache = { at: 0, value: null };

/** Whether the OpenClaw gateway answers right now (cached for a few seconds). */
async function probeOpenClaw({ env = process.env, fetchImpl = fetch, force = false } = {}) {
  const config = getOpenClawConfig(env);
  if (!config.configured || !config.allowed) {
    return { configured: config.configured, allowed: config.allowed, reachable: false };
  }
  const now = Date.now();
  if (!force && probeCache.value && now - probeCache.at < PROBE_CACHE_MS) return probeCache.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let value;
  try {
    const response = await fetchImpl(`${config.baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
    // 404/405 still means a server is listening (some gateways only expose
    // chat/completions); 401/403 means the token is wrong.
    const unauthorized = response.status === 401 || response.status === 403;
    value = {
      configured: true,
      allowed: true,
      reachable: !unauthorized && response.status < 500,
      unauthorized,
    };
  } catch {
    value = { configured: true, allowed: true, reachable: false };
  } finally {
    clearTimeout(timer);
  }
  probeCache.at = now;
  probeCache.value = value;
  return value;
}

async function getAnswerSourcesStatus({ env = process.env, fetchImpl = fetch } = {}) {
  const search = getSearchConfig(env);
  return {
    openclaw: await probeOpenClaw({ env, fetchImpl }),
    ollamaSearch: {
      configured: Boolean(search.ollamaKey),
      usedToday: getDefaultSearchCounter().get(),
      dailyCap: getOllamaDailyCap(env),
    },
    gemini: { configured: Boolean(search.geminiKey) },
    tavily: { configured: Boolean(search.tavilyKey) },
    searxng: { configured: Boolean(search.searxngUrl) },
  };
}

function _resetProbeCache() {
  probeCache.at = 0;
  probeCache.value = null;
}

module.exports = {
  DEFAULT_OPENCLAW_URL,
  DEFAULT_OPENCLAW_MODEL,
  getOpenClawConfig,
  readSseData,
  normalizeMessages,
  toGeminiRequest,
  streamOpenClaw,
  streamGemini,
  probeOpenClaw,
  getAnswerSourcesStatus,
  _resetProbeCache,
};

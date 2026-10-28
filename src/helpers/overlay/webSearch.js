// Overlay: web search without any OpenWhispr account.
//
// Order of providers (first one that is configured wins, later ones are
// fallbacks if the earlier one fails):
//   1. Ollama web search API                      (OLLAMA_API_KEY, ollama.com account)
//   2. Gemini API with Google Search grounding   (GEMINI_API_KEY)
//   3. Tavily search API                          (TAVILY_API_KEY)
//   4. A SearxNG instance you run yourself        (SEARXNG_URL)
//
// Every provider returns the same shape the agent's web_search tool already
// understands: { results: [{ title, url, text, publishedDate }] }.
// Keys are read from process.env (filled from the app's userData .env or the
// encrypted key store); they are never logged.

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_SEARCH_MODEL = "gemini-2.5-flash";
const TAVILY_URL = "https://api.tavily.com/search";
const OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const REQUEST_TIMEOUT_MS = 20000;

const PLACEHOLDER_RE = /^(your_|<|xxx|changeme|replace)/i;

function readKey(env, name) {
  const value = (env?.[name] || "").trim();
  if (!value || PLACEHOLDER_RE.test(value)) return "";
  return value;
}

function getSearchConfig(env = process.env) {
  return {
    ollamaKey: readKey(env, "OLLAMA_API_KEY"),
    geminiKey: readKey(env, "GEMINI_API_KEY"),
    geminiModel: (env.OVERLAY_GEMINI_MODEL || "").trim() || DEFAULT_GEMINI_SEARCH_MODEL,
    tavilyKey: readKey(env, "TAVILY_API_KEY"),
    searxngUrl: (env.SEARXNG_URL || "").trim().replace(/\/+$/, ""),
  };
}

function hasAnySearchProvider(env = process.env) {
  const c = getSearchConfig(env);
  return Boolean(c.ollamaKey || c.geminiKey || c.tavilyKey || c.searxngUrl);
}

async function fetchJson(fetchImpl, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.detail || `HTTP ${response.status}`;
      const error = new Error(String(message).slice(0, 300));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Turns a Gemini generateContent response (with grounding) into search results. */
function parseGeminiGrounded(data, numResults = 5) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const answer = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  const meta = candidate?.groundingMetadata || {};
  const chunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
  const supports = Array.isArray(meta.groundingSupports) ? meta.groundingSupports : [];

  // Collect the answer sentences each source supports, so every result has text.
  const snippets = chunks.map(() => []);
  for (const support of supports) {
    const segmentText = support?.segment?.text;
    if (!segmentText) continue;
    for (const index of support.groundingChunkIndices || []) {
      if (snippets[index] && snippets[index].length < 3) snippets[index].push(segmentText);
    }
  }

  const sources = chunks
    .map((chunk, index) => ({
      title: chunk?.web?.title || chunk?.web?.domain || "Source",
      url: chunk?.web?.uri || "",
      text: snippets[index].join(" "),
      publishedDate: null,
    }))
    .filter((r) => r.url);

  const results = [];
  if (answer) {
    results.push({
      title: "Google Search summary (Gemini)",
      url: sources[0]?.url || "",
      text: answer,
      publishedDate: null,
    });
  }
  results.push(...sources.slice(0, Math.max(1, numResults)));
  return { answer, sources, results, queries: meta.webSearchQueries || [] };
}

async function geminiSearch(query, numResults, { apiKey, model, fetchImpl }) {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Search the web and answer concisely with up-to-date facts. ` +
              `Mention dates when they matter.\n\nQuery: ${query}`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
  };
  const data = await fetchJson(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  return parseGeminiGrounded(data, numResults).results;
}

const DEFAULT_OLLAMA_DAILY_CAP = 20;

/** Plain-language message for a failed search request (never includes the key). */
function friendlyError(provider, error) {
  const name =
    { ollama: "Ollama web search", gemini: "Gemini", tavily: "Tavily", searxng: "SearxNG" }[
      provider
    ] || provider;
  if (error?.status === 401 || error?.status === 403) {
    return `${name}: the API key was rejected (check the key)`;
  }
  if (error?.status === 429) return `${name}: rate limit or quota reached, try again later`;
  if (error?.status >= 500) return `${name}: the service is having problems (HTTP ${error.status})`;
  if (error?.name === "AbortError") return `${name}: timed out`;
  if (!error?.status) return `${name}: network error (are you online?)`;
  return `${name}: ${error.message}`;
}

/**
 * Local per-day counter for Ollama web searches. Ollama hasn't published a
 * free-tier search quota, so Overlay stops itself at a soft cap
 * (OVERLAY_OLLAMA_SEARCH_DAILY_CAP, default 20) and falls back to the next
 * provider. Stored as {date, count} in a small JSON file in userData.
 */
function createDailyCounter({
  filePath,
  fsImpl = require("fs"),
  today = () => new Date().toLocaleDateString("en-CA"),
} = {}) {
  let memory = { date: today(), count: 0 };
  const read = () => {
    let state = memory;
    if (filePath) {
      try {
        state = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
      } catch {
        state = memory;
      }
    }
    if (!state || state.date !== today()) state = { date: today(), count: 0 };
    return state;
  };
  const write = (state) => {
    memory = state;
    if (!filePath) return;
    try {
      fsImpl.writeFileSync(filePath, JSON.stringify(state), "utf8");
    } catch {}
  };
  return {
    get: () => read().count,
    increment: () => {
      const state = read();
      state.count += 1;
      write(state);
      return state.count;
    },
  };
}

function getOllamaDailyCap(env = process.env) {
  const n = parseInt(env.OVERLAY_OLLAMA_SEARCH_DAILY_CAP || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_OLLAMA_DAILY_CAP;
}

let defaultCounter = createDailyCounter();
function setDefaultSearchCounter(counter) {
  defaultCounter = counter;
}
function getDefaultSearchCounter() {
  return defaultCounter;
}

async function ollamaWebSearch(query, numResults, { apiKey, fetchImpl }) {
  const data = await fetchJson(fetchImpl, OLLAMA_WEB_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: Math.min(Math.max(numResults, 1), 10) }),
  });
  return (data?.results || []).slice(0, numResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    text: r.content || "",
    publishedDate: r.published_date || r.publishedDate || null,
  }));
}

async function tavilySearch(query, numResults, { apiKey, fetchImpl }) {
  const data = await fetchJson(fetchImpl, TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      max_results: Math.min(Math.max(numResults, 1), 10),
      include_answer: true,
    }),
  });
  const results = [];
  if (data?.answer) {
    results.push({ title: "Tavily answer", url: "", text: data.answer, publishedDate: null });
  }
  for (const r of data?.results || []) {
    results.push({
      title: r.title || "",
      url: r.url || "",
      text: r.content || "",
      publishedDate: r.published_date || null,
    });
  }
  return results;
}

async function searxngSearch(query, numResults, { baseUrl, fetchImpl }) {
  const url = `${baseUrl}/search?format=json&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(fetchImpl, url, { method: "GET" });
  return (data?.results || []).slice(0, numResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    text: r.content || "",
    publishedDate: r.publishedDate || null,
  }));
}

const NO_PROVIDER_MESSAGE =
  "Web search is not set up. Add OLLAMA_API_KEY (ollama.com → Settings → Keys) to the .env " +
  "file in Overlay's settings folder, or a GEMINI_API_KEY in Settings → API Keys, or " +
  "TAVILY_API_KEY / SEARXNG_URL in the same .env, then restart Overlay.";

/**
 * Runs a web search with the first configured provider, falling back to the
 * next one when a provider fails. Never throws.
 */
async function runWebSearch(query, numResults = 5, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger;
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) return { success: false, error: "Empty search query", code: "BAD_REQUEST" };
  const n = Number.isFinite(numResults) ? Math.min(Math.max(Math.round(numResults), 1), 10) : 5;

  const config = getSearchConfig(env);
  const counter = options.counter || defaultCounter;
  const cap = getOllamaDailyCap(env);
  const errors = [];
  const attempts = [];
  if (config.ollamaKey) {
    if (counter.get() >= cap) {
      errors.push(
        `Ollama web search: daily limit of ${cap} searches reached (change OVERLAY_OLLAMA_SEARCH_DAILY_CAP)`
      );
    } else {
      attempts.push([
        "ollama",
        () => {
          counter.increment();
          return ollamaWebSearch(q, n, { apiKey: config.ollamaKey, fetchImpl });
        },
      ]);
    }
  }
  if (config.geminiKey) {
    attempts.push([
      "gemini",
      () => geminiSearch(q, n, { apiKey: config.geminiKey, model: config.geminiModel, fetchImpl }),
    ]);
  }
  if (config.tavilyKey) {
    attempts.push(["tavily", () => tavilySearch(q, n, { apiKey: config.tavilyKey, fetchImpl })]);
  }
  if (config.searxngUrl) {
    attempts.push([
      "searxng",
      () => searxngSearch(q, n, { baseUrl: config.searxngUrl, fetchImpl }),
    ]);
  }
  if (attempts.length === 0) {
    if (errors.length) {
      return { success: false, error: errors.join("; "), code: "SEARCH_LIMIT" };
    }
    return { success: false, error: NO_PROVIDER_MESSAGE, code: "NO_SEARCH_PROVIDER" };
  }

  for (const [provider, run] of attempts) {
    try {
      const results = await run();
      return { success: true, provider, results };
    } catch (error) {
      // Only the provider name and message: never the key or headers.
      errors.push(friendlyError(provider, error));
      logger?.warn?.("Overlay web search provider failed", { provider, error: error.message });
    }
  }
  return {
    success: false,
    error: `Web search failed: ${errors.join("; ")}`,
    code: "SEARCH_FAILED",
  };
}

module.exports = {
  OLLAMA_WEB_SEARCH_URL,
  DEFAULT_OLLAMA_DAILY_CAP,
  createDailyCounter,
  getOllamaDailyCap,
  setDefaultSearchCounter,
  getDefaultSearchCounter,
  friendlyError,
  GEMINI_API_BASE,
  DEFAULT_GEMINI_SEARCH_MODEL,
  NO_PROVIDER_MESSAGE,
  getSearchConfig,
  hasAnySearchProvider,
  parseGeminiGrounded,
  runWebSearch,
  fetchJson,
};

// Real-time System-1 Decision Router for Overlay Command mode.
// Routes utterances into coarse execution lanes via local strands-decider
// (POST /v1/systemone) with a fast non-thinking Ollama fallback.

const { isLoopbackUrl } = require("./llmClient");

const DEFAULT_STRANDS_DECIDER_URL = "http://127.0.0.1:8000/v1/systemone";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3:4b-instruct";
const DEFAULT_STRANDS_TIMEOUT_MS = 1500;
const DEFAULT_OLLAMA_TIMEOUT_MS = 2500;

const ROUTE_LANES = [
  "os_app",
  "mcp_tool",
  "file_search",
  "web_search",
  "compose_writing",
  "chat",
];

const ROUTE_JSON_SCHEMA = {
  type: "object",
  properties: {
    lane: { type: "string", enum: ROUTE_LANES },
    confidence: { type: "number" },
  },
  required: ["lane", "confidence"],
  additionalProperties: false,
};

function clampConfidence(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function normalizeLane(value) {
  const raw = String(value || "").trim().toLowerCase();
  return ROUTE_LANES.includes(raw) ? raw : "unknown";
}

function summarizeMcpTools(mcpTools) {
  if (!Array.isArray(mcpTools) || !mcpTools.length) return [];
  return mcpTools
    .slice(0, 24)
    .map((tool) => ({
      server: tool?.server || "",
      name: tool?.name || tool?.tool || "",
      description: String(tool?.description || "").slice(0, 120),
    }))
    .filter((t) => t.name);
}

function buildRouteInstructions(mcpTools) {
  const tools = summarizeMcpTools(mcpTools);
  const toolHint = tools.length
    ? `Available MCP tools: ${tools.map((t) => `${t.server ? `${t.server}.` : ""}${t.name}`).join(", ")}.`
    : "No external MCP tools are currently connected.";
  return (
    "Classify the user utterance into exactly one execution lane: " +
    `${ROUTE_LANES.join(", ")}. ${toolHint}`
  );
}

function buildRouteCriteria(mcpTools) {
  const tools = summarizeMcpTools(mcpTools);
  return {
    os_app: "Open, launch, switch to, or control a local desktop application or system setting.",
    mcp_tool: tools.length
      ? "Invoke a connected MCP tool/integration (e.g. GitHub, filesystem, database, calendar, or API tool)."
      : "Request an external tool or integration action.",
    file_search: "Find, locate, or open a local file or folder on disk.",
    web_search: "Search the web or open a website/URL in a browser.",
    compose_writing: "Draft, write, or type text/email into an app or editor.",
    chat: "Conversational question, explanation, brainstorming, or general chat that needs no desktop/tool action.",
  };
}

function normalizeOllamaBaseUrl(value, fallback = DEFAULT_OLLAMA_BASE_URL) {
  const raw = String(value || fallback).trim().replace(/\/+$/, "");
  if (!raw) return fallback;
  return raw.replace(/\/api\/chat$/i, "").replace(/\/v1$/i, "");
}

function parseStrandsRouteResponse(json) {
  const routeNode =
    json?.answers?.route ??
    json?.results?.route ??
    json?.route ??
    json;

  let rawChoice = "";
  let rawConfidence;

  if (typeof routeNode === "string") {
    rawChoice = routeNode;
  } else if (routeNode && typeof routeNode === "object") {
    rawChoice =
      routeNode.choice ??
      routeNode.lane ??
      routeNode.value ??
      routeNode.answer ??
      "";
    rawConfidence =
      routeNode.confidence ??
      routeNode.probability ??
      routeNode.calibrated_probability ??
      routeNode.score;
    if (rawConfidence == null && routeNode.probabilities && typeof routeNode.probabilities === "object") {
      rawConfidence = routeNode.probabilities[rawChoice];
    }
  }

  const lane = normalizeLane(rawChoice);
  if (lane === "unknown") {
    return { lane: "unknown", confidence: 0, source: "strands-decider" };
  }
  const confidence = clampConfidence(rawConfidence, 0.7);
  return { lane, confidence, source: "strands-decider" };
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller ? controller.signal : init?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function decideWithStrandsDecider(text, options = {}) {
  const {
    url = DEFAULT_STRANDS_DECIDER_URL,
    mcpTools,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_STRANDS_TIMEOUT_MS,
  } = options;

  if (!isLoopbackUrl(url)) {
    throw new Error("strands-decider URL must be a loopback address");
  }

  const tools = summarizeMcpTools(mcpTools);
  const body = {
    state: {
      utterance: String(text || ""),
      mcpTools: tools,
    },
    questions: {
      route: {
        type: "choice",
        choices: ROUTE_LANES,
        instructions: buildRouteInstructions(mcpTools),
        criteria: buildRouteCriteria(mcpTools),
      },
    },
  };

  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!response || !response.ok) {
    throw new Error(`strands-decider HTTP ${response?.status || "error"}`);
  }

  const json = await response.json();
  return parseStrandsRouteResponse(json);
}

async function decideWithOllama(text, options = {}) {
  const {
    baseUrl = DEFAULT_OLLAMA_BASE_URL,
    model = DEFAULT_OLLAMA_MODEL,
    mcpTools,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_OLLAMA_TIMEOUT_MS,
  } = options;

  const cleanBase = normalizeOllamaBaseUrl(baseUrl, DEFAULT_OLLAMA_BASE_URL);
  if (!isLoopbackUrl(cleanBase)) {
    throw new Error("Ollama decision router URL must be a loopback address");
  }

  const systemPrompt = [
    buildRouteInstructions(mcpTools),
    "Criteria:",
    ...Object.entries(buildRouteCriteria(mcpTools)).map(([lane, desc]) => `- ${lane}: ${desc}`),
    'Respond with JSON only: {"lane":"<one of the lanes>","confidence":<0..1>}.',
  ].join("\n");

  const response = await fetchWithTimeout(
    fetchImpl,
    `${cleanBase}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: ROUTE_JSON_SCHEMA,
        options: {
          temperature: 0,
          num_predict: 80,
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: String(text || "") },
        ],
      }),
    },
    timeoutMs
  );

  if (!response || !response.ok) {
    throw new Error(`Ollama router HTTP ${response?.status || "error"}`);
  }

  const json = await response.json();
  const rawContent = json?.message?.content ?? json?.choices?.[0]?.message?.content;
  const parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
  const lane = normalizeLane(parsed?.lane);
  if (lane === "unknown") {
    return { lane: "unknown", confidence: 0, source: "ollama" };
  }
  const confidence = clampConfidence(parsed?.confidence, 0.7);
  return { lane, confidence, source: "ollama" };
}

function createDecisionRouter(options = {}) {
  const {
    strandsUrl = DEFAULT_STRANDS_DECIDER_URL,
    strandsEnabled = true,
    strandsTimeoutMs = DEFAULT_STRANDS_TIMEOUT_MS,
    ollamaBaseUrl = DEFAULT_OLLAMA_BASE_URL,
    ollamaModel = DEFAULT_OLLAMA_MODEL,
    ollamaEnabled = true,
    ollamaTimeoutMs = DEFAULT_OLLAMA_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  return async function decideRoute(text, context = {}) {
    if (!String(text || "").trim()) {
      return { lane: "unknown", confidence: 0, source: "none" };
    }

    const mcpTools = context?.mcpTools ?? options.mcpTools;

    if (strandsEnabled && strandsUrl) {
      try {
        const result = await decideWithStrandsDecider(text, {
          url: strandsUrl,
          mcpTools,
          fetchImpl,
          timeoutMs: strandsTimeoutMs,
        });
        if (result && result.lane !== "unknown") {
          return result;
        }
      } catch {
        // Fall through to Ollama fallback.
      }
    }

    if (ollamaEnabled && ollamaBaseUrl) {
      try {
        const result = await decideWithOllama(text, {
          baseUrl: ollamaBaseUrl,
          model: ollamaModel,
          mcpTools,
          fetchImpl,
          timeoutMs: ollamaTimeoutMs,
        });
        if (result && result.lane !== "unknown") {
          return result;
        }
      } catch {
        // Fall through to unknown.
      }
    }

    return { lane: "unknown", confidence: 0, source: "none" };
  };
}

module.exports = {
  DEFAULT_STRANDS_DECIDER_URL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  ROUTE_LANES,
  ROUTE_JSON_SCHEMA,
  decideWithStrandsDecider,
  decideWithOllama,
  createDecisionRouter,
  parseStrandsRouteResponse,
};

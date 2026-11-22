// Compose a finished document with the user's configured chat model.
// Thinking is allowed. Local timeout is generous so a letter can take time.

const {
  DEFAULT_LOCAL_BASE,
  DEFAULT_LOCAL_MODEL,
  PARSE_KEEP_ALIVE,
  isLoopbackUrl,
  normalizeBaseUrl,
  nativeOllamaBase,
  cloudConfig,
} = require("./llmClient");

const COMPOSE_LOCAL_TIMEOUT_MS = 120000;
const COMPOSE_MAX_TOKENS = 400;
const COMPOSE_NUM_CTX = 8192;

function timeoutError() {
  const err = new Error("Writing timed out");
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

function buildComposePrompt(userPrompt) {
  return [
    "You write the finished document the user asked for.",
    "Output ONLY the document text itself.",
    'Do not add a preamble such as "Here is your letter" or "Sure, here you go".',
    "Do not wrap the document in markdown fences or a title.",
    "If the user asked for a letter, include a greeting and a sign-off.",
    "Write in the same language the user used.",
    "First decide: if the request only dictates exact words to type (for example",
    '"write good morning team"), output exactly those words and nothing else.',
    "Otherwise write the document properly.",
    "",
    "Request:",
    String(userPrompt || "").trim(),
  ].join("\n");
}

function stripComposeOutput(raw) {
  let s = String(raw || "");
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<thought>[\s\S]*?<\/thought>/gi, "");
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  const fenced = s.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1];
  s = s.trim();
  s = s.replace(
    /^(?:here(?:'|’)s|here is|here are)\s+(?:your|the)\s+(?:letter|email|note|text|poem|message|essay|paragraph)[:\s-]*/i,
    ""
  );
  s = s.replace(
    /^(?:sure[,.]?\s+)?(?:i(?:'|’)ve written|i have written)\s+(?:your|the|a)\s+(?:letter|email|note)[:\s-]*/i,
    ""
  );
  return s.trim();
}

function contentFromMessage(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.type === "text" ? part.text : "")).join("\n");
  }
  return "";
}

function contentFromChunk(json) {
  if (!json || typeof json !== "object") return "";
  const native = json?.message?.content;
  if (typeof native === "string") return native;
  return contentFromMessage(
    json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.message?.content || native
  );
}

async function readStreamText(response, onToken) {
  if (response && typeof response.text === "function" && !response.body) {
    const text = await response.text();
    return accumulateJsonLines(text, onToken) || stripComposeOutput(text);
  }
  const body = response?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/);
      buffer = lines.pop() || "";
      out += takeJsonLines(lines, onToken);
    }
    if (buffer.trim()) out += takeJsonLines([buffer], onToken);
    return out;
  }
  if (typeof response.json === "function") {
    const json = await response.json();
    return contentFromChunk(json);
  }
  return "";
}

function takeJsonLines(lines, onToken) {
  let out = "";
  for (const line of lines) {
    const trimmed = String(line || "").replace(/^data:\s*/, "").trim();
    if (!trimmed || trimmed === "[DONE]") continue;
    try {
      const json = JSON.parse(trimmed);
      const piece = contentFromChunk(json);
      if (piece) {
        out += piece;
        if (typeof onToken === "function") onToken(piece);
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return out;
}

function accumulateJsonLines(text, onToken) {
  return takeJsonLines(String(text || "").split(/\r?\n/), onToken);
}

async function completeOpenAiCompose({ url, key, model, prompt, fetchImpl, signal, headers = {} }) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: COMPOSE_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content: "Write only the finished document. No preamble, no markdown fences.",
        },
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    const err = new Error(`Writer HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const json = await response.json();
  return contentFromMessage(json?.choices?.[0]?.message?.content);
}

function createComposeCompleter(opts = {}) {
  const {
    parser = "local",
    model,
    localBaseUrl,
    cloudProvider,
    env = process.env,
    fetchImpl = fetch,
    timeoutMs,
  } = opts;

  return async function composeComplete(userPrompt, { signal, onToken } = {}) {
    const prompt = buildComposePrompt(userPrompt);
    const usedTimeout = Number.isFinite(timeoutMs) ? timeoutMs : COMPOSE_LOCAL_TIMEOUT_MS;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const onAbort = () => controller?.abort();
    if (signal && controller) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = controller ? setTimeout(() => controller.abort(), usedTimeout) : null;
    try {
      if (parser === "cloud") {
        const cloud = cloudConfig(cloudProvider, env);
        if (!cloud.key || !cloud.url) {
          throw new Error("No cloud API key is configured for writing");
        }
        const raw = await completeOpenAiCompose({
          url: cloud.url,
          key: cloud.key,
          model: model || cloud.model,
          prompt,
          fetchImpl,
          signal: controller?.signal,
          headers: cloud.headers || {},
        });
        return stripComposeOutput(raw);
      }

      const base = normalizeBaseUrl(localBaseUrl, DEFAULT_LOCAL_BASE);
      if (!isLoopbackUrl(base) || !isLoopbackUrl(localBaseUrl || base)) {
        throw new Error("Local Command mode can only call a model on this computer");
      }
      const nativeBase = nativeOllamaBase(localBaseUrl || base);
      const chosen = model || DEFAULT_LOCAL_MODEL;
      const response = await fetchImpl(`${nativeBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: chosen,
          stream: true,
          keep_alive: PARSE_KEEP_ALIVE,
          options: {
            temperature: 0.7,
            num_ctx: COMPOSE_NUM_CTX,
            num_predict: COMPOSE_MAX_TOKENS,
          },
          messages: [
            {
              role: "system",
              content: "Write only the finished document. No preamble, no markdown fences.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: controller?.signal,
      });
      if (!response.ok) {
        if (response.status === 404) {
          const raw = await completeOpenAiCompose({
            url: `${base}/chat/completions`,
            key: "",
            model: chosen,
            prompt,
            fetchImpl,
            signal: controller?.signal,
          });
          return stripComposeOutput(raw);
        }
        const err = new Error(`Writer HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      const raw = await readStreamText(response, onToken);
      return stripComposeOutput(raw);
    } catch (error) {
      throw wrapAbort(error);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && controller) signal.removeEventListener?.("abort", onAbort);
    }
  };
}

module.exports = {
  COMPOSE_LOCAL_TIMEOUT_MS,
  COMPOSE_MAX_TOKENS,
  COMPOSE_NUM_CTX,
  buildComposePrompt,
  stripComposeOutput,
  createComposeCompleter,
};
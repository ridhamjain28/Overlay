const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createIntentCompleter,
  pickLocalParseModel,
  pickCloudModel,
  isThinkingModel,
  cloudConfig,
  PREFERRED_LOCAL_PARSE_MODEL,
} = require("../../src/helpers/overlay/commandMode/llmClient");

test("qwen3.5 and qwen3:8b are treated as thinking; qwen3 instruct is not", () => {
  assert.equal(isThinkingModel("qwen3.5:4b-q4_K_M"), true);
  assert.equal(isThinkingModel("qwen3:8b"), true);
  assert.equal(isThinkingModel("qwen3:4b-instruct"), false);
  assert.equal(isThinkingModel("qwen3:8b-instruct"), false);
});

test("pickLocalParseModel prefers installed instruct when the chat model is thinking", () => {
  assert.equal(
    pickLocalParseModel("qwen3:8b", ["qwen3:4b-instruct", "qwen3:8b"]),
    "qwen3:4b-instruct"
  );
  assert.equal(
    pickLocalParseModel("qwen3.5:4b-q4_K_M", ["qwen3:4b-instruct", "qwen3.5:4b-q4_K_M"]),
    "qwen3:4b-instruct"
  );
  assert.equal(
    pickLocalParseModel("qwen3:4b-instruct", ["qwen3:4b-instruct", "qwen3:8b"]),
    "qwen3:4b-instruct"
  );
  assert.equal(
    pickLocalParseModel("qwen3:8b", ["qwen3:8b"]),
    "qwen3:8b"
  );
  assert.equal(PREFERRED_LOCAL_PARSE_MODEL, "qwen3:4b-instruct");
});

test("local completer uses native /api/chat with think false, ctx 8192, skill prompt, and JSON schema", async () => {
  const seen = [];
  const complete = createIntentCompleter({
    parser: "local",
    localBaseUrl: "http://localhost:11434/v1",
    model: "qwen3:8b",
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: "qwen3:4b-instruct" }, { name: "qwen3:8b" }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ message: { content: '{"action":"none"}' } }),
      };
    },
  });
  const text = await complete("hello");
  assert.equal(text, '{"action":"none"}');
  assert.equal(seen[0].url, "http://localhost:11434/api/tags");
  assert.equal(seen[1].url, "http://localhost:11434/api/chat");
  assert.equal(seen[1].body.model, "qwen3:4b-instruct");
  assert.equal(seen[1].body.think, false);
  assert.equal(seen[1].body.keep_alive, -1);
  assert.equal(seen[1].body.options.num_ctx, 8192);
  assert.equal(seen[1].body.options.num_predict, 400);
  assert.equal(seen[1].body.stream, false);
  assert.equal(seen[1].body.format.type, "object");
  assert.ok(seen[1].body.format.properties.action);
  assert.equal(seen[1].body.messages[0].role, "system");
  assert.match(seen[1].body.messages[0].content, /Overlay Command Skill/);
  assert.match(seen[1].body.messages[0].content, /version:\s*4/);
  assert.equal(seen[1].body.messages[1].role, "user");
  assert.equal(seen[1].body.messages[1].content, "hello");
});

test("local completer refuses a non-loopback base URL", async () => {
  const complete = createIntentCompleter({
    parser: "local",
    localBaseUrl: "https://evil.example/v1",
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  await assert.rejects(() => complete("prompt"), /this computer/);
});

test("pickCloudModel never sends local Ollama tags to cloud providers and uses current Anthropic Haiku", async () => {
  assert.equal(pickCloudModel("anthropic", "qwen3:8b", "claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
  assert.equal(pickCloudModel("openai", "qwen3.5:4b-q4_K_M", "gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(pickCloudModel("gemini", "qwen3:4b-instruct", "gemini-2.0-flash"), "gemini-2.0-flash");
  assert.equal(pickCloudModel("openrouter", "qwen3:8b", "openrouter/auto"), "openrouter/auto");
  assert.equal(pickCloudModel("openai", "gpt-4o", "gpt-4o-mini"), "gpt-4o");
  assert.equal(pickCloudModel("anthropic", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"), "claude-sonnet-4-6");

  const cfg = cloudConfig("anthropic", { ANTHROPIC_API_KEY: "test-key" });
  assert.equal(cfg.model, "claude-haiku-4-5-20251001");
  assert.equal(cfg.isAnthropic, true);

  let sentBody = null;
  let sentHeaders = null;
  const cloudComplete = createIntentCompleter({
    parser: "cloud",
    cloudProvider: "anthropic",
    model: "qwen3:8b",
    env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    fetchImpl: async (_url, init) => {
      sentHeaders = init.headers;
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: '{"action":"none"}' }] }),
      };
    },
  });
  const out = await cloudComplete("hello");
  assert.equal(out, '{"action":"none"}');
  assert.equal(sentBody.model, "claude-haiku-4-5-20251001");
  assert.equal(sentHeaders["x-api-key"], "test-anthropic-key");
});

test("local completer skips /api/tags when model is already non-thinking and honors external AbortSignal", async () => {
  const seenUrls = [];
  const complete = createIntentCompleter({
    parser: "local",
    localBaseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:4b-instruct",
    fetchImpl: async (url) => {
      seenUrls.push(url);
      return {
        ok: true,
        json: async () => ({ message: { content: '{"action":"none"}' } }),
      };
    },
  });

  const out = await complete("hello");
  assert.equal(out, '{"action":"none"}');
  assert.deepEqual(seenUrls, ["http://127.0.0.1:11434/api/chat"]);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => complete("hello", { signal: ac.signal }), (err) => err.code === "CANCELLED");
});
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createIntentCompleter,
  pickLocalParseModel,
  isThinkingModel,
  PREFERRED_LOCAL_PARSE_MODEL,
} = require("../../src/helpers/overlay/commandMode/llmClient");

test("qwen3.5 is treated as thinking; qwen3 instruct is not", () => {
  assert.equal(isThinkingModel("qwen3.5:4b-q4_K_M"), true);
  assert.equal(isThinkingModel("qwen3:4b-instruct"), false);
});

test("pickLocalParseModel prefers installed instruct when the chat model is thinking", () => {
  assert.equal(
    pickLocalParseModel("qwen3.5:4b-q4_K_M", ["qwen3:4b-instruct", "qwen3.5:4b-q4_K_M"]),
    "qwen3:4b-instruct"
  );
  assert.equal(
    pickLocalParseModel("qwen3:4b-instruct", ["qwen3:4b-instruct", "qwen3.5:4b-q4_K_M"]),
    "qwen3:4b-instruct"
  );
  assert.equal(
    pickLocalParseModel("qwen3.5:4b-q4_K_M", ["qwen3.5:4b-q4_K_M"]),
    "qwen3.5:4b-q4_K_M"
  );
  assert.equal(PREFERRED_LOCAL_PARSE_MODEL, "qwen3:4b-instruct");
});

test("local completer uses native /api/chat with think false, ctx 4096, and instruct when installed", async () => {
  const seen = [];
  const complete = createIntentCompleter({
    parser: "local",
    localBaseUrl: "http://localhost:11434/v1",
    model: "qwen3.5:4b-q4_K_M",
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: "qwen3:4b-instruct" }, { name: "qwen3.5:4b-q4_K_M" }],
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
  assert.equal(seen[1].body.keep_alive, "30m");
  assert.equal(seen[1].body.options.num_ctx, 4096);
  assert.equal(seen[1].body.options.num_predict, 150);
  assert.equal(seen[1].body.stream, false);
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
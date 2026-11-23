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

test("local completer uses native /api/chat with think false, ctx 8192, skill prompt, and JSON schema", async () => {
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
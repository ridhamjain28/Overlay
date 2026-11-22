const test = require("node:test");
const assert = require("node:assert/strict");
const {
  stripComposeOutput,
  buildComposePrompt,
  createComposeCompleter,
} = require("../../src/helpers/overlay/commandMode/composeClient");

test("stripComposeOutput drops think tags, fences, and preambles", () => {
  const raw = [
    "<think>planning the letter</think>",
    "Here is your letter:",
    "",
    "```",
    "Dear Mother,",
    "",
    "Please let me come home for a holiday.",
    "",
    "Love,",
    "Ridham",
    "```",
  ].join("\n");
  const out = stripComposeOutput(raw);
  assert.match(out, /^Dear Mother,/);
  assert.match(out, /Love,\nRidham/);
  assert.doesNotMatch(out, /here is your letter/i);
  assert.doesNotMatch(out, /planning the letter/);
  assert.doesNotMatch(out, /```/);
});

test("stripComposeOutput leaves a bare letter alone", () => {
  const letter = "Dear Mum,\n\nCan I come home?\n\nLove";
  assert.equal(stripComposeOutput(letter), letter);
});

test("buildComposePrompt asks for a finished document with no preamble", () => {
  const prompt = buildComposePrompt("a letter to my mother asking for a holiday to come home");
  assert.match(prompt, /finished document/i);
  assert.match(prompt, /preamble/i);
  assert.match(prompt, /a letter to my mother asking for a holiday to come home/);
});

test("createComposeCompleter uses the configured chat model and streams tokens", async () => {
  const calls = [];
  const chunks = [
    '{"message":{"content":"Dear "}}\n',
    '{"message":{"content":"Mother,"}}\n',
    '{"done":true}\n',
  ];
  const completer = createComposeCompleter({
    parser: "local",
    model: "qwen3.5:4b-q4_K_M",
    localBaseUrl: "http://127.0.0.1:11434/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        text: async () => chunks.join(""),
      };
    },
  });
  const tokens = [];
  const text = await completer("write a letter to mum", { onToken: (t) => tokens.push(t) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/chat$/);
  assert.equal(calls[0].body.model, "qwen3.5:4b-q4_K_M");
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.options.num_predict, 2048);
  assert.ok(!Object.prototype.hasOwnProperty.call(calls[0].body, "think"));
  assert.equal(text, "Dear Mother,");
  assert.deepEqual(tokens, ["Dear ", "Mother,"]);
});

test("cloud compose uses a large token budget and does not disable thinking", async () => {
  const calls = [];
  const completer = createComposeCompleter({
    parser: "cloud",
    model: "gpt-4o-mini",
    cloudProvider: "openai",
    env: { OPENAI_API_KEY: "sk-test" },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Dear Boss,\n\nI am sick today.\n" } }],
        }),
      };
    },
  });
  const text = await completer("write an email to my boss saying I'm sick");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "gpt-4o-mini");
  assert.equal(calls[0].body.max_tokens, 2048);
  assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.match(text, /Dear Boss/);
});
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInworldTts,
  splitText,
  DEFAULT_VOICE_ID,
  SYNTHESIZE_URL,
} = require("../../src/helpers/inworldTts.js");

test("splitText keeps short replies in one chunk and splits long ones on a sentence", () => {
  assert.deepEqual(splitText("Hello there."), ["Hello there."]);
  const long = `${"a".repeat(1800)}. ${"b".repeat(400)}`;
  const chunks = splitText(long);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith("."));
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
});

test("missing or placeholder keys do not call Inworld", async () => {
  const calls = [];
  const tts = createInworldTts({
    getKey: () => "",
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error("should not fetch");
    },
  });
  assert.equal(tts.hasKey(), false);
  const result = await tts.synthesize({ text: "Hello" });
  assert.deepEqual(result, { success: false, error: "not_configured" });
  assert.equal(calls.length, 0);

  const placeholder = createInworldTts({
    getKey: () => "your_key_here",
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error("should not fetch");
    },
  });
  assert.equal(placeholder.hasKey(), false);
  const skipped = await placeholder.synthesize({ text: "Hello" });
  assert.equal(skipped.error, "not_configured");
  assert.equal(calls.length, 0);
});

test("synthesize sends Basic auth and never includes the key in a failure message", async () => {
  const key = "test-inworld-credential";
  const calls = [];
  const tts = createInworldTts({
    getKey: () => key,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ message: `Invalid key ${key} was rejected` }),
      };
    },
  });

  const result = await tts.synthesize({ text: "Hello from Overlay.", voiceId: "Dennis" });
  assert.equal(result.success, false);
  assert.equal(result.status, 401);
  assert.equal(result.error.includes(key), false);
  assert.match(result.error, /\[redacted\]/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SYNTHESIZE_URL);
  assert.equal(calls[0].options.headers.Authorization, `Basic ${key}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.voiceId, "Dennis");
  assert.equal(body.modelId, "inworld-tts-2");
  assert.equal(body.audioConfig.audioEncoding, "MP3");
  assert.equal(body.text, "Hello from Overlay.");
});

test("a successful synthesize returns MP3 audio without exposing the key", async () => {
  const key = "test-inworld-credential";
  const tts = createInworldTts({
    getKey: () => key,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ audioContent: "ZmFrZS1tcDM=" }),
    }),
  });
  const result = await tts.synthesize({ text: "Hello" });
  assert.equal(result.success, true);
  assert.deepEqual(result.audioBase64Parts, ["ZmFrZS1tcDM="]);
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.voiceId, DEFAULT_VOICE_ID);
  assert.equal(JSON.stringify(result).includes(key), false);
});

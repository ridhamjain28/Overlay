const test = require("node:test");
const assert = require("node:assert/strict");

const { listOllamaModels } = require("../../src/helpers/overlay/answerSources");

const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

test("listOllamaModels returns the pulled model names", async () => {
  let url;
  const names = await listOllamaModels({
    fetchImpl: async (u) => {
      url = u;
      return jsonResponse({ models: [{ name: "qwen3:4b-instruct" }, { model: "qwen2.5:7b" }] });
    },
  });
  assert.equal(url, "http://localhost:11434/api/tags");
  assert.deepEqual(names, ["qwen3:4b-instruct", "qwen2.5:7b"]);
});

test("listOllamaModels returns null when Ollama is not running", async () => {
  const names = await listOllamaModels({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(names, null);
  assert.equal(await listOllamaModels({ fetchImpl: async () => jsonResponse({}, false) }), null);
});

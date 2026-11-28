const test = require("node:test");
const assert = require("node:assert/strict");
const ws = require("../../src/helpers/overlay/webSearch.js");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const freshCounter = () => ws.createDailyCounter();

test("no key: friendly message, no crash", async () => {
  const r = await ws.runWebSearch("news", 5, { env: {}, counter: freshCounter() });
  assert.equal(r.success, false);
  assert.equal(r.code, "NO_SEARCH_PROVIDER");
  assert.match(r.error, /OLLAMA_API_KEY/);
});

test("placeholder keys are ignored", async () => {
  const r = await ws.runWebSearch("q", 5, {
    env: { OLLAMA_API_KEY: "your_key_here" },
    counter: freshCounter(),
  });
  assert.equal(r.code, "NO_SEARCH_PROVIDER");
});

test("Ollama web search: request shape and result mapping", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return json({ results: [{ title: "T", url: "https://a.example", content: "body" }] });
  };
  const r = await ws.runWebSearch("india news", 3, {
    env: { OLLAMA_API_KEY: "k123" },
    fetchImpl,
    counter: freshCounter(),
  });
  assert.equal(seen.url, "https://ollama.com/api/web_search");
  assert.equal(seen.init.headers.Authorization, "Bearer k123");
  assert.deepEqual(JSON.parse(seen.init.body), { query: "india news", max_results: 3 });
  assert.equal(r.success, true);
  assert.equal(r.provider, "ollama");
  assert.equal(r.results[0].url, "https://a.example");
  assert.equal(r.results[0].text, "body");
});

test("max_results is capped at 10", async () => {
  let body;
  await ws.runWebSearch("q", 50, {
    env: { OLLAMA_API_KEY: "k" },
    fetchImpl: async (_u, init) => ((body = JSON.parse(init.body)), json({ results: [] })),
    counter: freshCounter(),
  });
  assert.equal(body.max_results, 10);
});

for (const [status, re] of [
  [401, /key was rejected/],
  [429, /rate limit/],
  [503, /having problems/],
]) {
  test(`Ollama ${status} gives a plain message`, async () => {
    const r = await ws.runWebSearch("q", 5, {
      env: { OLLAMA_API_KEY: "k" },
      fetchImpl: async () => json({ error: "x" }, status),
      counter: freshCounter(),
    });
    assert.equal(r.success, false);
    assert.match(r.error, re);
    assert.doesNotMatch(r.error, /Bearer|\bk\b/);
  });
}

test("network error gives a plain message", async () => {
  const r = await ws.runWebSearch("q", 5, {
    env: { OLLAMA_API_KEY: "k" },
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    counter: freshCounter(),
  });
  assert.match(r.error, /network error/);
});

test("falls back from a failing Ollama to Tavily", async () => {
  const fetchImpl = async (url) =>
    url.includes("ollama.com")
      ? json({}, 429)
      : json({ results: [{ title: "Tav", url: "https://t.example", content: "c" }] });
  const r = await ws.runWebSearch("q", 5, {
    env: { OLLAMA_API_KEY: "k", TAVILY_API_KEY: "t" },
    fetchImpl,
    counter: freshCounter(),
  });
  assert.equal(r.success, true);
  assert.equal(r.provider, "tavily");
});

test("Gemini grounded search maps grounding chunks", async () => {
  const fetchImpl = async () =>
    json({
      candidates: [
        {
          content: { parts: [{ text: "Answer text." }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://g.example", title: "g.example" } }],
            groundingSupports: [{ segment: { text: "Answer text." }, groundingChunkIndices: [0] }],
          },
        },
      ],
    });
  const r = await ws.runWebSearch("q", 5, {
    env: { GEMINI_API_KEY: "g" },
    fetchImpl,
    counter: freshCounter(),
  });
  assert.equal(r.success, true);
  assert.equal(r.provider, "gemini");
  assert.equal(r.results[0].url, "https://g.example");
});

test("daily soft cap stops Ollama searches and says so", async () => {
  const counter = freshCounter();
  const env = { OLLAMA_API_KEY: "k", OVERLAY_OLLAMA_SEARCH_DAILY_CAP: "2" };
  const fetchImpl = async () => json({ results: [] });
  await ws.runWebSearch("a", 5, { env, fetchImpl, counter });
  await ws.runWebSearch("b", 5, { env, fetchImpl, counter });
  const r = await ws.runWebSearch("c", 5, { env, fetchImpl, counter });
  assert.equal(r.code, "SEARCH_LIMIT");
  assert.match(r.error, /daily limit of 2/);
  assert.equal(ws.getOllamaDailyCap({}), 20);
});

test("daily counter persists to a file and resets on a new day", () => {
  const files = {};
  const fsImpl = {
    readFileSync: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    writeFileSync: (p, d) => (files[p] = d),
  };
  let day = "2026-10-28";
  const c = ws.createDailyCounter({ filePath: "/u.json", fsImpl, today: () => day });
  c.increment();
  c.increment();
  assert.equal(ws.createDailyCounter({ filePath: "/u.json", fsImpl, today: () => day }).get(), 2);
  day = "2026-10-29";
  assert.equal(c.get(), 0);
});

test("sanitizes upstream secrets in errors, rejects non-http SEARXNG_URL, and handles corrupted counter", async () => {
  assert.equal(ws.getSearchConfig(null).searxngUrl, "");
  assert.equal(ws.getSearchConfig({ SEARXNG_URL: "file:///etc/passwd" }).searxngUrl, "");
  assert.equal(ws.getOllamaDailyCap(null), ws.DEFAULT_OLLAMA_DAILY_CAP);

  const warned = [];
  const r = await ws.runWebSearch("q", 5, {
    env: { TAVILY_API_KEY: "tvly-secretkey1234567890" },
    fetchImpl: async () =>
      json({ error: { message: "Rejected Bearer tok_123 and tvly-secretkey1234567890" } }, 400),
    logger: { warn: (_msg, meta) => warned.push(meta.error) },
    counter: freshCounter(),
  });
  assert.equal(r.success, false);
  assert.doesNotMatch(r.error, /tok_123|secretkey1234567890/);
  assert.match(r.error, /\[REDACTED\]/);
  assert.doesNotMatch(warned[0], /tok_123|secretkey1234567890/);

  const parsed = ws.parseGeminiGrounded({
    candidates: [
      {
        content: { parts: [{ text: "ok" }] },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: "https://a.example", title: "A" } }],
          groundingSupports: [{ segment: { text: "ok" }, groundingChunkIndices: "bad" }],
        },
      },
    ],
  });
  assert.equal(parsed.sources.length, 1);

  const counter = ws.createDailyCounter({
    filePath: "/dir/counter.json",
    fsImpl: {
      readFileSync: () => JSON.stringify({ date: new Date().toLocaleDateString("en-CA"), count: "bad" }),
      writeFileSync: () => {},
    },
  });
  assert.equal(counter.get(), 0);
  assert.equal(counter.increment(), 1);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const loadRouter = () => import("../../src/services/overlay/answerRouter.ts");
const loadStream = () => import("../../src/services/overlay/remoteAnswerStream.ts");
const loadCtx = () => import("../../src/services/overlay/webContext.ts");
const loadChat = () => import("../../src/utils/modelSize.ts");

const up = { openclaw: { configured: true, reachable: true }, gemini: { configured: true } };
const down = { openclaw: { configured: true, reachable: false }, gemini: { configured: true } };
const none = { openclaw: { configured: false, reachable: false }, gemini: { configured: false } };

test("intent classification (English + Hinglish)", async () => {
  const { classifyIntent } = await loadRouter();
  assert.equal(classifyIntent("open chrome"), "action");
  assert.equal(classifyIntent("can you please open chrome"), "action");
  assert.equal(classifyIntent("open source licenses comparison"), "chat");
  assert.equal(classifyIntent("volume kam karo, awaaz"), "action");
  assert.equal(classifyIntent("latest news about ISRO"), "web");
  assert.equal(classifyIntent("aaj ka weather kya hai"), "web");
  assert.equal(classifyIntent("write a haiku about tea"), "chat");
});

test("auto routing: chat local; web/action OpenClaw then Gemini/local", async () => {
  const { planAnswerSources } = await loadRouter();
  assert.deepEqual(planAnswerSources("auto", "chat", up), ["local"]);
  assert.deepEqual(planAnswerSources("auto", "web", up), ["openclaw", "gemini", "local"]);
  assert.deepEqual(planAnswerSources("auto", "web", down), ["gemini", "local"]);
  assert.deepEqual(planAnswerSources("auto", "action", down), ["local"]);
  assert.deepEqual(planAnswerSources("auto", "web", none), ["local"]);
  assert.deepEqual(planAnswerSources("local", "web", up), ["local"]);
  assert.deepEqual(planAnswerSources("gemini", "chat", up), ["gemini", "local"]);
  assert.deepEqual(
    planAnswerSources("auto", "web", {
      openclaw: { configured: true, reachable: true, unauthorized: true },
      gemini: { configured: true },
    }),
    ["gemini", "local"]
  );
});

test("getAnswerSourcesStatus caches, deduplicates concurrent calls, and supports force refresh", async () => {
  const { getAnswerSourcesStatus, resetAnswerSourcesStatusCache } = await loadRouter();
  resetAnswerSourcesStatusCache();
  let calls = 0;
  const prevWindow = globalThis.window;
  globalThis.window = {
    electronAPI: {
      overlayAnswerSourcesStatus: async () => {
        calls += 1;
        return {
          openclaw: { configured: true, reachable: calls > 1 },
          gemini: { configured: true },
        };
      },
    },
  };
  try {
    const [a, b] = await Promise.all([getAnswerSourcesStatus(), getAnswerSourcesStatus()]);
    assert.equal(calls, 1, "concurrent callers should share one IPC probe");
    assert.equal(a.openclaw.reachable, false);
    assert.equal(b.openclaw.reachable, false);

    const cached = await getAnswerSourcesStatus();
    assert.equal(calls, 1, "cached value should be returned within TTL");
    assert.equal(cached.openclaw.reachable, false);

    const refreshed = await getAnswerSourcesStatus(true);
    assert.equal(calls, 2, "force=true must bypass cache");
    assert.equal(refreshed.openclaw.reachable, true);
  } finally {
    resetAnswerSourcesStatusCache();
    globalThis.window = prevWindow;
  }
});

test("unknown setting values fall back to auto", async () => {
  const { normalizeAnswerSourceSetting } = await loadRouter();
  assert.equal(normalizeAnswerSourceSetting("bogus"), "auto");
  assert.equal(normalizeAnswerSourceSetting("openclaw"), "openclaw");
});

test("withFallback skips a source that fails before any text", async () => {
  const { withFallback } = await loadStream();
  const failed = [];
  // eslint-disable-next-line require-yield -- fails before producing any text
  async function* bad() {
    throw new Error("down");
  }
  async function* good() {
    yield { type: "content", text: "ok" };
    yield { type: "done" };
  }
  const out = [];
  for await (const c of withFallback(
    [
      { source: "openclaw", create: bad },
      { source: "local", create: good },
    ],
    (s) => failed.push(s)
  ))
    out.push(c);
  assert.deepEqual(failed, ["openclaw"]);
  assert.equal(out[0].text, "ok");
});

test("sources are listed under the answer exactly once", async () => {
  const { appendSources, sourcesFrom, formatWebContext } = await loadCtx();
  const resp = {
    success: true,
    provider: "ollama",
    results: [
      { title: "A", url: "https://a.example", text: "x" },
      { title: "A dup", url: "https://a.example", text: "y" },
      { title: "B", url: "https://b.example", text: "z" },
    ],
  };
  const sources = sourcesFrom(resp);
  assert.equal(sources.length, 2);
  assert.match(formatWebContext(resp), /WEB SEARCH RESULTS/);
  async function* s() {
    yield { type: "content", text: "Answer [1]" };
    yield { type: "done" };
  }
  const out = [];
  for await (const c of appendSources(s(), sources)) out.push(c);
  assert.equal(out.at(-1).type, "done");
  const text = out
    .filter((c) => c.type === "content")
    .map((c) => c.text)
    .join("");
  assert.match(text, /Sources:\n1\. \[A\]\(https:\/\/a\.example\/?\)\n2\. \[B\]/);
});

test("no-provider search result tells the model to ask for a key", async () => {
  const { formatWebContext } = await loadCtx();
  const block = formatWebContext({ success: false, code: "NO_SEARCH_PROVIDER", error: "x" });
  assert.match(block, /OLLAMA_API_KEY/);
});

test("model size is read from Ollama-style tags", async () => {
  const { estimateModelSizeB } = await loadChat();
  assert.equal(estimateModelSizeB("qwen3.5:4b-q4_K_M"), 4);
  assert.equal(estimateModelSizeB("qwen2.5:7b"), 7);
  assert.equal(estimateModelSizeB("llama-3.1-8b-instruct"), 8);
  assert.equal(estimateModelSizeB("qwen3:0.6b"), 0.6);
});

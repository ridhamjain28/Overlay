const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const ctx = require("../../src/helpers/overlay/chatContext");
const { createChatMemoryStore } = require("../../src/helpers/overlay/chatMemoryStore");
const req = require("../../src/helpers/overlay/requirements");

const GIB = 1024 * 1024 * 1024;

async function loadMemory() {
  const mod = await import("../../src/components/chat/chatMemory.ts");
  return mod.planChatMemory ? mod : mod.default;
}

async function loadHistory() {
  const mod = await import("../../src/components/chat/historyMessages.ts");
  return mod.toHistoryMessages ? mod : mod.default;
}

function openSqlite(t) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(":memory:");
  } catch {
    t.skip("node:sqlite is not available in this Node runtime");
    return null;
  }
}

const jsonFetch = (routes) => async (url) => {
  const path = new URL(url).pathname;
  if (!(path in routes)) throw new Error("unreachable");
  return { ok: true, json: async () => routes[path] };
};

test("chat window is sized by system memory and never below the baseline or above the ceiling", () => {
  assert.equal(ctx.chatContextTarget("auto", 8 * GIB), 8192);
  assert.equal(ctx.chatContextTarget("auto", 16 * GIB), 16384);
  assert.equal(ctx.chatContextTarget("auto", 32 * GIB), 32768);
  assert.equal(ctx.chatContextTarget("auto", 64 * GIB), 65536);
  assert.equal(ctx.chatContextTarget("extra-long", 8 * GIB), 32768);
  assert.equal(ctx.chatContextTarget("nonsense", 32 * GIB), 32768);
  assert.equal(ctx.normalizeChatContextSetting("max"), "max");
  assert.equal(ctx.normalizeChatContextSetting(42), "auto");

  const baseline = 16384;
  // Small machines keep the baseline every other caller relies on.
  assert.equal(ctx.llamaChatContextSize({ target: 8192, ceiling: 65536, baseline }), 16384);
  assert.equal(ctx.llamaChatContextSize({ target: 32768, ceiling: 65536, baseline }), 32768);
  // The per-model memory ceiling always wins over the request.
  assert.equal(ctx.llamaChatContextSize({ target: 65536, ceiling: 24576, baseline }), 24576);
  assert.equal(ctx.llamaChatContextSize({ target: 65536, ceiling: null, baseline }), 16384);

  ctx.setChatContextSetting("long");
  assert.equal(ctx.getChatContextSetting(), "long");
  ctx.setChatContextSetting("bogus");
  assert.equal(ctx.getChatContextSetting(), "auto");
});

test("the window Ollama actually loaded is read back; non-Ollama servers report nothing", async () => {
  assert.equal(ctx.ollamaNativeBase("http://localhost:11434/v1/"), "http://localhost:11434");
  assert.equal(ctx.ollamaNativeBase(""), "http://127.0.0.1:11434");

  const loaded = jsonFetch({
    "/api/ps": { models: [{ name: "qwen3:4b", model: "qwen3:4b", context_length: 32768 }] },
  });
  assert.equal(
    await ctx.ollamaLoadedContext({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3:4b",
      fetchImpl: loaded,
    }),
    32768
  );
  assert.equal(
    await ctx.ollamaLoadedContext({
      model: "llama3",
      fetchImpl: jsonFetch({
        "/api/ps": { models: [{ name: "llama3:latest", context_length: 8192 }] },
      }),
    }),
    8192
  );
  // Not loaded yet: assume Ollama's small default so the chat is fitted, not overflowed.
  assert.equal(
    await ctx.ollamaLoadedContext({ model: "other", fetchImpl: loaded }),
    ctx.OLLAMA_FALLBACK_CONTEXT
  );
  assert.equal(await ctx.ollamaLoadedContext({ model: "x", fetchImpl: jsonFetch({}) }), null);
});

test("Overlay starts Ollama with the chosen window, since its /v1 endpoint ignores one per request", async () => {
  const seen = [];
  const r = req.createRequirements({
    env: { PATH: "x" },
    platform: "win32",
    fsImpl: { existsSync: () => true, statSync: () => ({ isDirectory: () => false }) },
    execFile: (_f, _a, _o, cb) => cb(null, "", ""),
    execSync: () => "C:\\Ollama\\ollama.exe",
    fetch: async () => ({ ok: true, json: async () => ({ models: [] }) }),
    spawn: (file, args, opts) => {
      seen.push({ file, args, opts });
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
    dryRun: false,
  });
  const result = await r.install("ollama", { contextLength: 32768 });
  assert.equal(result.success, true);
  assert.deepEqual(seen[0].args, ["serve"]);
  assert.equal(seen[0].opts.env.OLLAMA_CONTEXT_LENGTH, "32768");
  assert.equal(seen[0].opts.env.PATH, "x");
  assert.equal(seen[0].opts.windowsHide, true);

  // Without a window the step is exactly what it was before.
  assert.deepEqual(r.installSteps("ollama-start", { ollama: "ollama" }), [
    { file: "ollama", args: ["serve"], background: true },
  ]);
});

test("facts are picked up from English and Hinglish messages", async () => {
  const m = await loadMemory();
  const facts = (text) => m.extractFacts(text).map((f) => f.fact);
  assert.deepEqual(facts("Hi, my name is Ridham and I need help"), ["The user's name is Ridham."]);
  assert.deepEqual(facts("mera naam Ridham hai"), ["The user's name is Ridham."]);
  assert.deepEqual(facts("I work at Acme Labs, mostly on audio"), ["The user works at Acme Labs."]);
  assert.deepEqual(facts("I live in Pune"), ["The user lives in Pune."]);
  assert.match(facts("please remember that the demo is on Friday")[0], /demo is on Friday/);
  assert.match(facts("yaad rakhna ki meeting 5 baje hai")[0], /meeting 5 baje/);
  assert.deepEqual(facts("what is the weather today?"), []);
  assert.equal(m.extractFacts("call me Sam").at(0).key, "name");
});

test("recent turns that fit stay as messages; older ones roll into notes and come back when relevant", async () => {
  const m = await loadMemory();
  const filler = "lorem ipsum dolor sit amet ".repeat(40);
  const history = [
    { role: "user", content: "My project is called Nimbus and it renders weather maps." },
    { role: "assistant", content: "Got it, Nimbus renders weather maps." },
  ];
  for (let i = 0; i < 120; i++) {
    history.push({ role: "user", content: `question ${i} ${filler}` });
    history.push({ role: "assistant", content: `answer ${i} ${filler}` });
  }
  history.push({ role: "user", content: "What does my Nimbus project render again?" });

  const plan = m.planChatMemory({
    history,
    userText: "What does my Nimbus project render again?",
    windowTokens: 8192,
    systemPrompt: "You are helpful.",
    recalled: { facts: ["The user's name is Ridham."], related: [] },
  });
  const used = plan.history.reduce((sum, msg) => sum + m.estimateTokens(msg.content), 0);
  assert.ok(used <= m.historyBudget({ windowTokens: 8192, systemPrompt: "You are helpful." }) + 64);
  assert.ok(plan.history.length >= 4 && plan.history.length < history.length);
  assert.equal(plan.history.at(-1).content, history.at(-1).content);
  assert.equal(plan.history[0].role, "user");
  assert.match(plan.memoryBlock, /The user's name is Ridham\./);
  assert.match(plan.memoryBlock, /Earlier in this conversation/);
  assert.match(plan.memoryBlock, /Nimbus renders weather maps/);
  assert.equal(plan.remember.covered, history.length);
  assert.equal(plan.remember.key, m.conversationKey(history));

  // A short chat goes as-is, with nothing extra.
  const short = m.planChatMemory({
    history: history.slice(0, 3),
    userText: "hi",
    windowTokens: 8192,
    systemPrompt: "",
    recalled: { facts: [], related: [] },
  });
  assert.equal(short.history.length, 3);
  assert.equal(short.memoryBlock, "");

  // A bigger window keeps more of the chat in view.
  const big = m.planChatMemory({
    history,
    userText: "x",
    windowTokens: 65536,
    systemPrompt: "",
    recalled: { facts: [], related: [] },
  });
  assert.ok(big.history.length > plan.history.length);
});

test("with memory off the original last-20 history is unchanged", async () => {
  const h = await loadHistory();
  const msgs = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    role: i % 2 ? "assistant" : "user",
    content: `m${i}`,
  }));
  assert.equal(h.toHistoryMessages(msgs, { includeToolTrace: false }).length, 20);
  assert.equal(h.toHistoryMessages(msgs, { includeToolTrace: false, limit: Infinity }).length, 30);
});

test("long-term memory lives in sqlite, is recalled by relevance and can be cleared", (t) => {
  const db = openSqlite(t);
  if (!db) return;
  let clock = 1000;
  const store = createChatMemoryStore(db, { now: () => clock++ });
  store.remember("c1", {
    facts: [{ key: "name", fact: "The user's name is Ridham." }],
    summary: "- User: Planning the Goa trip budget and hotels.\n  You: Suggested three hotels.",
    covered: 4,
  });
  store.remember("c2", { summary: "- User: Fix the printer driver.", covered: 2 });
  store.remember("c3", { facts: [{ key: "name", fact: "The user's name is Ridz." }] });

  const recalled = store.recall("c3", "what hotels did we shortlist for goa?");
  assert.deepEqual(recalled.facts, ["The user's name is Ridz."]);
  assert.equal(recalled.related.length, 1);
  assert.match(recalled.related[0], /Goa trip/);
  // The current chat is never recalled into itself.
  assert.deepEqual(store.searchSummaries("goa hotels", { excludeKey: "c1" }), []);
  assert.match(store.recall("c9", "printer driver keeps failing").related[0], /printer driver/);
  assert.equal(store.getSummary("c1").covered, 4);

  for (let i = 0; i < 60; i++) store.addFacts([{ key: `k${i}`, fact: `fact ${i}` }]);
  assert.equal(store.listFacts().length, 40);
  assert.equal(store.listFacts()[0], "fact 59");

  store.clear();
  assert.deepEqual(store.listFacts(), []);
  assert.equal(store.getSummary("c1"), null);
  db.close();
});

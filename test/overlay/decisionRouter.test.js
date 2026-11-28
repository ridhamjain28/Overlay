const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_STRANDS_DECIDER_URL,
  ROUTE_LANES,
  decideWithStrandsDecider,
  decideWithOllama,
  createDecisionRouter,
} = require("../../src/helpers/overlay/commandMode/decisionRouter");
const { createOrchestrator } = require("../../src/helpers/overlay/commandMode/orchestrator");

test("decideWithStrandsDecider enforces loopback URLs", async () => {
  await assert.rejects(
    () =>
      decideWithStrandsDecider("open notepad", {
        url: "https://remote.example.com/v1/systemone",
        fetchImpl: async () => {
          throw new Error("should not call fetch for non-loopback URL");
        },
      }),
    /loopback/i
  );

  // Also check that createDecisionRouter never throws on a non-loopback URL and falls back gracefully.
  const decideRoute = createDecisionRouter({
    strandsUrl: "https://remote.example.com/v1/systemone",
    ollamaEnabled: false,
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  const res = await decideRoute("open notepad");
  assert.deepEqual(res, { lane: "unknown", confidence: 0, source: "none" });
});

test("decideWithStrandsDecider posts choice question to /v1/systemone and parses response", async () => {
  let capturedUrl = "";
  let capturedBody = null;

  const res = await decideWithStrandsDecider("list my open github issues", {
    url: DEFAULT_STRANDS_DECIDER_URL,
    mcpTools: [{ server: "github", name: "list_issues", description: "List repository issues" }],
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            route: {
              choice: "mcp_tool",
              confidence: 0.92,
            },
          },
        }),
      };
    },
  });

  assert.equal(capturedUrl, "http://127.0.0.1:8000/v1/systemone");
  assert.equal(capturedBody.state.utterance, "list my open github issues");
  assert.equal(capturedBody.questions.route.type, "choice");
  assert.ok(capturedBody.questions.route.instructions.includes("github.list_issues"));
  assert.ok(capturedBody.questions.route.criteria);
  assert.deepEqual(res, {
    lane: "mcp_tool",
    confidence: 0.92,
    source: "strands-decider",
  });
  assert.ok(ROUTE_LANES.includes(res.lane));
});

test("createDecisionRouter falls back to Ollama /api/chat when strands-decider is offline", async () => {
  const calls = [];
  const decideRoute = createDecisionRouter({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.includes(":8000")) {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:8000");
        err.code = "ECONNREFUSED";
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: {
            content: JSON.stringify({ lane: "web_search", confidence: 0.87 }),
          },
        }),
      };
    },
  });

  const res = await decideRoute("search the web for node 22 release notes");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/systemone");
  assert.equal(calls[1].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[1].body.think, false);
  assert.deepEqual(calls[1].body.format.required, ["lane", "confidence"]);
  assert.deepEqual(res, {
    lane: "web_search",
    confidence: 0.87,
    source: "ollama",
  });
});

test("createDecisionRouter returns unknown with confidence 0 when both routers are offline", async () => {
  const decideRoute = createDecisionRouter({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  const res = await decideRoute("open notepad");
  assert.deepEqual(res, { lane: "unknown", confidence: 0, source: "none" });
});

test("decideWithOllama enforces loopback URL", async () => {
  await assert.rejects(
    () =>
      decideWithOllama("hello", {
        baseUrl: "http://192.168.1.50:11434",
        fetchImpl: async () => {
          throw new Error("should not call fetch");
        },
      }),
    /loopback/i
  );
});

test("orchestrator forces LLM when decideRoute returns mcp_tool and skips commands for high-confidence chat", async () => {
  const parseCalls = [];
  const mcpCalls = [];

  const orch = createOrchestrator({
    decideRoute: async (text) => {
      if (text.includes("explain")) {
        return { lane: "chat", confidence: 0.93, source: "strands-decider" };
      }
      return { lane: "mcp_tool", confidence: 0.78, source: "strands-decider" };
    },
    parseIntent: async (text, opts) => {
      parseCalls.push({ text, forceLlm: Boolean(opts?.forceLlm) });
      return {
        action: "mcp",
        type: "mcp",
        server: "github",
        tool: "list_issues",
        args: { repo: "Overlay" },
        source: "llm",
      };
    },
    confirm: async () => true,
    callMcpTool: async (server, tool, args) => {
      mcpCalls.push({ server, tool, args });
      return { content: [{ type: "text", text: "Issue #1: Wire decision router" }] };
    },
  });

  // High-confidence chat should skip parseIntent and return clean non-command plan/outcome.
  const chatPlan = await orch.plan("can you explain how TCP congestion control works?");
  assert.equal(chatPlan.steps.length, 0);
  assert.deepEqual(chatPlan.intent, { action: "none" });
  assert.equal(chatPlan.source, "decision-router");
  assert.equal(chatPlan.route.lane, "chat");
  assert.equal(parseCalls.length, 0);

  const chatOutcome = await orch.orchestrate("can you explain how TCP congestion control works?");
  assert.equal(chatOutcome.handled, false);
  assert.equal(chatOutcome.source, "decision-router");
  assert.equal(chatOutcome.route.lane, "chat");
  assert.equal(parseCalls.length, 0);

  // mcp_tool >= 0.55 should pass forceLlm: true to parseIntent and expose route metadata.
  const mcpOutcome = await orch.orchestrate("check my github issues", {
    mcpTools: [{ server: "github", name: "list_issues" }],
  });
  assert.equal(parseCalls.length, 1);
  assert.equal(parseCalls[0].forceLlm, true);
  assert.equal(mcpOutcome.handled, true);
  assert.equal(mcpOutcome.success, true);
  assert.equal(mcpOutcome.route.lane, "mcp_tool");
  assert.equal(mcpCalls.length, 1);
  assert.match(mcpOutcome.message, /Wire decision router/);
});

test("orchestrator fast heuristic skips decideRoute latency for clear local commands", async () => {
  let routerCalls = 0;
  const orch = createOrchestrator({
    parseHeuristic: (text) => {
      if (text === "open spotify") {
        return { action: "open_app", args: { app: "spotify" }, confidence: 0.95, source: "heuristic" };
      }
      return { action: "none", args: {}, confidence: 0.2, source: "heuristic" };
    },
    decideRoute: async () => {
      routerCalls += 1;
      return { lane: "chat", confidence: 0.9, source: "strands-decider" };
    },
    parseIntent: async () => ({ action: "none", args: {} }),
  });

  const fastPlan = await orch.plan("open spotify");
  assert.equal(routerCalls, 0, "confident local heuristic must bypass decision router delay");
  assert.equal(fastPlan.steps.length, 1);
  assert.equal(fastPlan.steps[0].action, "open_app");

  const routedPlan = await orch.plan("what is quantum entanglement?");
  assert.equal(routerCalls, 1, "low-confidence heuristic falls through to decision router");
  assert.equal(routedPlan.source, "decision-router");
});

test("createDecisionRouter fast-fails strands-decider during cooldown after connection or timeout failure and recovers after cooldown", async () => {
  let clock = 1000;
  let strandsCalls = 0;
  let ollamaCalls = 0;
  let strandsOnline = false;

  const decideRoute = createDecisionRouter({
    strandsCooldownMs: 30000,
    now: () => clock,
    fetchImpl: async (url) => {
      if (url.includes(":8000")) {
        strandsCalls += 1;
        if (!strandsOnline) {
          const err = new Error("connect ECONNREFUSED 127.0.0.1:8000");
          err.code = "ECONNREFUSED";
          throw err;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ answers: { route: { choice: "chat", confidence: 0.91 } } }),
        };
      }
      ollamaCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: JSON.stringify({ lane: "web_search", confidence: 0.85 }) },
        }),
      };
    },
  });

  // First call probes strands (fails -> enters cooldown) and falls back to Ollama.
  const first = await decideRoute("search latest ai news");
  assert.equal(first.source, "ollama");
  assert.equal(strandsCalls, 1);
  assert.equal(ollamaCalls, 1);

  // Subsequent calls within cooldown skip strands completely and go straight to Ollama.
  clock += 10000;
  const second = await decideRoute("check weather today");
  assert.equal(second.source, "ollama");
  assert.equal(strandsCalls, 1, "redundant strands-decider probe must be skipped during cooldown");
  assert.equal(ollamaCalls, 2);

  // Once cooldown expires, strands is probed again and recovers.
  strandsOnline = true;
  clock += 20001;
  const third = await decideRoute("explain TCP congestion control");
  assert.equal(third.source, "strands-decider");
  assert.equal(third.lane, "chat");
  assert.equal(strandsCalls, 2, "strands-decider should be probed again after cooldown expires");
  assert.equal(ollamaCalls, 2);
});

test("createDecisionRouter triggers cooldown on timeout and clears immediately on reset()", async () => {
  let clock = 5000;
  let strandsCalls = 0;
  let strandsShouldTimeout = true;

  const decideRoute = createDecisionRouter({
    strandsTimeoutMs: 50,
    strandsCooldownMs: 30000,
    now: () => clock,
    fetchImpl: async (url, init) => {
      if (url.includes(":8000")) {
        strandsCalls += 1;
        if (strandsShouldTimeout) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ answers: { route: { choice: "mcp_tool", confidence: 0.9 } } }),
        };
      }
      assert.equal(init.method, "POST");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: JSON.stringify({ lane: "chat", confidence: 0.8 }) },
        }),
      };
    },
  });

  await decideRoute("list github issues");
  assert.equal(strandsCalls, 1);

  clock += 1000;
  await decideRoute("list github prs");
  assert.equal(strandsCalls, 1, "should skip strands during timeout cooldown");

  // Explicit reset() clears cooldown before expiry.
  strandsShouldTimeout = false;
  decideRoute.reset();
  const res = await decideRoute("list github issues");
  assert.equal(strandsCalls, 2);
  assert.equal(res.source, "strands-decider");
  assert.equal(res.lane, "mcp_tool");
});

test("createDecisionRouter does not trigger cooldown on HTTP error or unknown lane, and respects caller abort", async () => {
  let clock = 1000;
  let strandsCalls = 0;
  let ollamaCalls = 0;

  const decideRoute = createDecisionRouter({
    strandsCooldownMs: 30000,
    now: () => clock,
    fetchImpl: async (url) => {
      if (url.includes(":8000")) {
        strandsCalls += 1;
        return { ok: false, status: 500, json: async () => ({}) };
      }
      ollamaCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: JSON.stringify({ lane: "chat", confidence: 0.88 }) },
        }),
      };
    },
  });

  await decideRoute("first utterance");
  clock += 1000;
  await decideRoute("second utterance");
  assert.equal(strandsCalls, 2, "HTTP 500 is not a connection/timeout failure and must not engage cooldown");
  assert.equal(ollamaCalls, 2);

  // External abort returns unknown immediately without calling strands or ollama.
  const ac = new AbortController();
  ac.abort();
  const aborted = await decideRoute("cancelled utterance", { signal: ac.signal });
  assert.deepEqual(aborted, { lane: "unknown", confidence: 0, source: "none" });
  assert.equal(strandsCalls, 2);
  assert.equal(ollamaCalls, 2);
});

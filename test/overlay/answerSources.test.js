const test = require("node:test");
const assert = require("node:assert/strict");
const as = require("../../src/helpers/overlay/answerSources.js");

const sse = (lines) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );

test("OpenClaw config: defaults, full URL accepted, loopback only", () => {
  const c = as.getOpenClawConfig({ OPENCLAW_TOKEN: "t" });
  assert.equal(c.baseUrl, "http://127.0.0.1:18789/v1");
  assert.equal(c.model, "openclaw/default");
  assert.equal(c.allowed, true);
  const full = as.getOpenClawConfig({ OPENCLAW_URL: "http://localhost:18789/v1/chat/completions" });
  assert.equal(full.baseUrl, "http://localhost:18789/v1");
  assert.equal(full.configured, false);
  const remote = as.getOpenClawConfig({
    OPENCLAW_TOKEN: "t",
    OPENCLAW_URL: "http://10.0.0.5:18789/v1",
  });
  assert.equal(remote.allowed, false);
});

test("OpenClaw stream: SSE parsing, stream:true, stable user, bearer token", async () => {
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, init };
    return sse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  let text = "";
  for await (const t of as.streamOpenClaw({
    messages: [{ role: "user", content: "hi" }],
    user: "overlay-abc",
    env: { OPENCLAW_TOKEN: "secret" },
    fetchImpl,
  })) {
    text += t;
  }
  assert.equal(text, "Hello");
  assert.equal(req.url, "http://127.0.0.1:18789/v1/chat/completions");
  assert.equal(req.init.headers.Authorization, "Bearer secret");
  const body = JSON.parse(req.init.body);
  assert.equal(body.stream, true);
  assert.equal(body.user, "overlay-abc");
  assert.equal(body.model, "openclaw/default");
});

test("OpenClaw refuses to send the token to a non-loopback host", async () => {
  await assert.rejects(async () => {
    for await (const _ of as.streamOpenClaw({
      messages: [{ role: "user", content: "x" }],
      env: { OPENCLAW_TOKEN: "t", OPENCLAW_URL: "https://example.com/v1" },
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    }));
  }, /loopback/);
});

test("OpenClaw without token says how to set it up", async () => {
  await assert.rejects(async () => {
    for await (const _ of as.streamOpenClaw({ messages: [], env: {} }));
  }, /OPENCLAW_TOKEN/);
});

test("Gemini request uses google_search and system instruction", () => {
  const r = as.toGeminiRequest([
    { role: "system", content: "be brief" },
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ]);
  assert.deepEqual(r.tools, [{ google_search: {} }]);
  assert.equal(r.systemInstruction.parts[0].text, "be brief");
  assert.deepEqual(
    r.contents.map((c) => c.role),
    ["user", "model"]
  );
});

test("probe: unreachable gateway is reported, not thrown", async () => {
  as._resetProbeCache();
  const s = await as.probeOpenClaw({
    env: { OPENCLAW_TOKEN: "t" },
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    force: true,
  });
  assert.equal(s.reachable, false);
});

test("probeOpenClaw caches per URL and token, and rejects non-http URLs", async () => {
  as._resetProbeCache();
  assert.equal(as.getOpenClawConfig({ OPENCLAW_TOKEN: "t", OPENCLAW_URL: "ftp://localhost:1234" }).allowed, false);

  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return { status: url.includes("18790") ? 503 : 200 };
  };
  const s1 = await as.probeOpenClaw({
    env: { OPENCLAW_TOKEN: "t1", OPENCLAW_URL: "http://127.0.0.1:18789/v1" },
    fetchImpl,
  });
  assert.equal(s1.reachable, true);
  // Same URL + token hits cache
  await as.probeOpenClaw({
    env: { OPENCLAW_TOKEN: "t1", OPENCLAW_URL: "http://127.0.0.1:18789/v1" },
    fetchImpl,
  });
  assert.equal(calls, 1);
  // Different URL bypasses stale cache
  const s2 = await as.probeOpenClaw({
    env: { OPENCLAW_TOKEN: "t1", OPENCLAW_URL: "http://127.0.0.1:18790/v1" },
    fetchImpl,
  });
  assert.equal(s2.reachable, false);
  assert.equal(calls, 2);
});

test("readSseData cancels reader on early exit and streamGemini handles mid-stream error & safe source links", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const got = [];
  for await (const text of as.streamOpenClaw({
    messages: [{ role: "user", content: "hi" }],
    env: { OPENCLAW_TOKEN: "secret" },
    fetchImpl: async () => new Response(body, { status: 200 }),
  })) {
    got.push(text);
  }
  assert.deepEqual(got, ["hi"]);
  assert.equal(cancelled, true);

  await assert.rejects(async () => {
    for await (const _ of as.streamGemini({
      messages: [{ role: "user", content: "hi" }],
      env: { GEMINI_API_KEY: "AIzaFakeKey1234567890123456789012345678" },
      fetchImpl: async () =>
        sse(['data: {"error":{"message":"Invalid key Bearer tok_abc"}}\n\n']),
    })) {
      // no-op
    }
  }, /Bearer \[REDACTED\]/);
});

test("remoteAnswerStream handles pre-aborted signals, withFallback stops on abort, and webContext escapes URLs", async () => {
  const remoteMod = await import("../../src/services/overlay/remoteAnswerStream.ts");
  const { remoteAnswerStream, withFallback } = remoteMod.remoteAnswerStream ? remoteMod : remoteMod.default;
  const webCtxMod = await import("../../src/services/overlay/webContext.ts");
  const { sourcesFrom } = webCtxMod.sourcesFrom ? webCtxMod : webCtxMod.default;

  let started = false;
  const prevWindow = globalThis.window;
  globalThis.window = {
    electronAPI: {
      overlayAnswerStreamStart: () => {
        started = true;
      },
    },
  };
  try {
    const ac = new AbortController();
    ac.abort();
    const chunks = [];
    for await (const ch of remoteAnswerStream("openclaw", [{ role: "user", content: "hi" }], "u1", ac.signal)) {
      chunks.push(ch);
    }
    assert.equal(started, false);
    assert.deepEqual(chunks, [{ type: "done" }]);

    const ac2 = new AbortController();
    let fallbackCalled = false;
    const out = [];
    for await (const ch of withFallback(
      [
        {
          source: "openclaw",
          create: async function* () {
            if (ac2.signal.aborted) yield { type: "done" };
            ac2.abort();
            throw new Error("aborted");
          },
        },
        {
          source: "local",
          create: async function* () {
            fallbackCalled = true;
            yield { type: "content", text: "should not run" };
          },
        },
      ],
      undefined,
      ac2.signal
    )) {
      out.push(ch);
    }
    assert.equal(fallbackCalled, false);
    assert.deepEqual(out, []);
  } finally {
    globalThis.window = prevWindow;
  }

  const sources = sourcesFrom({
    success: true,
    results: [
      { title: "Bad [link]", url: "javascript:alert(1)" },
      { title: "Wiki [page]", url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    ],
  });
  assert.deepEqual(sources, [
    { title: "Wiki page", url: "https://en.wikipedia.org/wiki/Foo_%28bar%29" },
  ]);
});

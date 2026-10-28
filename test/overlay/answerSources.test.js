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

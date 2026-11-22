const test = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../../src/helpers/overlay/commandMode/intentParser");

test("open_app: open / launch / start / kholo", () => {
  for (const text of ["open Chrome", "launch notepad", "start Calculator", "kholo spotify"]) {
    const r = parser.parseIntentHeuristic(text);
    assert.equal(r.action, "open_app", text);
    assert.ok(r.args.app, text);
    assert.ok(r.confidence >= 0.8);
  }
  assert.equal(parser.parseIntentHeuristic("open Visual Studio Code").args.app.toLowerCase().includes("visual"), true);
});

test("open_url: full links, bare sites, and 'go to' / new tab", () => {
  const cases = [
    ["open https://example.com", "https://example.com/"],
    ["go to youtube.com", "https://youtube.com/"],
    ["open a new tab for https://github.com/ridhamjain28", "https://github.com/ridhamjain28"],
    ["visit www.wikipedia.org", "https://www.wikipedia.org/"],
  ];
  for (const [text, expected] of cases) {
    const r = parser.parseIntentHeuristic(text);
    assert.equal(r.action, "open_url", text);
    assert.ok(String(r.args.url).startsWith("http"), text);
    assert.ok(r.args.url.includes(new URL(expected).hostname.replace(/^www\./, "")) || r.args.url.includes("github.com"), text);
  }
});

test("open chrome is an app, not a URL", () => {
  const r = parser.parseIntentHeuristic("open chrome");
  assert.equal(r.action, "open_app");
  assert.equal(r.args.app, "chrome");
});

test("type_text reads quoted and unquoted words", () => {
  assert.equal(parser.parseIntentHeuristic('type "hello world"').args.text, "hello world");
  assert.equal(parser.parseIntentHeuristic("type this: meeting notes").args.text, "meeting notes");
  assert.equal(parser.parseIntentHeuristic("likho hello").action, "type_text");
});

test("run_command only when the user clearly wants a shell command", () => {
  const r = parser.parseIntentHeuristic("run ipconfig");
  assert.equal(r.action, "run_command");
  assert.equal(r.args.command, "ipconfig");
  assert.equal(parser.parseIntentHeuristic("run the command: dir").args.command, "dir");
  assert.equal(parser.parseIntentHeuristic("in the terminal, git status").action, "run_command");
});

test("run chrome is treated as open_app, not a shell command", () => {
  const r = parser.parseIntentHeuristic("run chrome");
  assert.equal(r.action, "open_app");
  assert.equal(r.args.app, "chrome");
});

test("guide: where is / point to / click the button", () => {
  assert.equal(parser.parseIntentHeuristic("where is the Save button").action, "guide");
  assert.equal(parser.parseIntentHeuristic("where is the Save button").args.target.toLowerCase(), "save");
  assert.equal(parser.parseIntentHeuristic("point to New Tab").action, "guide");
  assert.equal(parser.parseIntentHeuristic("click the Send button").action, "guide");
});

test("questions and chat are not commands", () => {
  for (const text of [
    "what is the capital of France",
    "explain how overlay works",
    "summarize this paragraph",
    "how does photosynthesis work",
  ]) {
    const r = parser.parseIntentHeuristic(text);
    assert.equal(r.action, "none", text);
  }
});

test("empty input is none", () => {
  assert.equal(parser.parseIntentHeuristic("").action, "none");
  assert.equal(parser.parseIntentHeuristic("   ").action, "none");
});

test("shouldUseLlm is false for a confident heuristic command", () => {
  const open = parser.parseIntentHeuristic("open notepad");
  assert.equal(parser.shouldUseLlm(open), false);
  const chat = parser.parseIntentHeuristic("what is rust");
  assert.equal(parser.shouldUseLlm(chat), false);
  const weak = parser.parseIntentHeuristic("kindly fire up the thing");
  assert.equal(weak.action, "none");
  assert.equal(parser.shouldUseLlm(weak), true);
});

test("parseIntentFromLlmResponse reads raw and fenced JSON", () => {
  const raw = parser.parseIntentFromLlmResponse(
    '{"action":"open_app","app":"spotify","confidence":0.9}'
  );
  assert.equal(raw.action, "open_app");
  assert.equal(raw.args.app, "spotify");

  const fenced = parser.parseIntentFromLlmResponse(
    'Sure.\n```json\n{"action":"open_url","url":"https://example.com","confidence":1}\n```'
  );
  assert.equal(fenced.action, "open_url");
  assert.ok(fenced.args.url.startsWith("https://example.com"));
});

test("parseIntentFromLlmResponse rejects unknown actions and file URLs", () => {
  assert.equal(parser.parseIntentFromLlmResponse('{"action":"shutdown"}').action, "none");
  assert.equal(
    parser.parseIntentFromLlmResponse('{"action":"open_url","url":"file:///C:/Windows"}').action,
    "none"
  );
});

test("parseIntent uses the heuristic and skips the LLM when confident", async () => {
  let called = 0;
  const r = await parser.parseIntent("open notepad", {
    llmComplete: async () => {
      called += 1;
      return '{"action":"none"}';
    },
  });
  assert.equal(r.action, "open_app");
  assert.equal(called, 0);
});

test("parseIntent asks the LLM when the heuristic is unsure", async () => {
  const r = await parser.parseIntent("kindly fire up the calculator app please", {
    llmComplete: async () => '{"action":"open_app","app":"calculator","confidence":0.8}',
  });
  assert.equal(r.action, "open_app");
  assert.equal(r.args.app, "calculator");
  assert.equal(r.source, "llm");
});

test("formatIntentForConfirm is readable", () => {
  assert.equal(
    parser.formatIntentForConfirm({ action: "open_app", args: { app: "chrome" } }),
    "Open app: chrome"
  );
  assert.match(
    parser.formatIntentForConfirm({ action: "run_command", args: { command: "ipconfig" } }),
    /ipconfig/
  );
});

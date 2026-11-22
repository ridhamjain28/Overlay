const test = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../../src/helpers/overlay/commandMode/intentParser");

test("polite wrappers become open_app without the LLM", () => {
  for (const text of [
    "can you open notepad?",
    "could you open notepad",
    "would you open notepad",
    "will you open notepad",
    "can u open notepad",
    "please open notepad",
    "pls open notepad",
    "hey overlay open notepad",
    "overlay, open notepad",
    "can you open notepad for me",
    "open notepad now",
  ]) {
    const r = parser.parseIntentHeuristic(text);
    assert.equal(r.action, "open_app", text);
    assert.match(r.args.app, /notepad/i, text);
    assert.equal(parser.shouldUseLlm(r), false, text);
  }
  assert.equal(parser.stripCommandWrappers("can you open notepad?"), "open notepad");
});

test("Hinglish verb-at-end opens the named app", () => {
  assert.equal(parser.parseIntentHeuristic("notepad kholo").action, "open_app");
  assert.equal(parser.parseIntentHeuristic("notepad kholo").args.app, "notepad");
  assert.equal(parser.parseIntentHeuristic("notepad khol do").args.app, "notepad");
});

test("chat patterns still win after wrappers, but can you write hello is type_text", () => {
  for (const text of [
    "can you explain gravity",
    "can you write an email",
    "can you write a poem",
    "explain how overlay works",
  ]) {
    const r = parser.parseIntentHeuristic(text);
    assert.equal(r.action, "none", text);
    assert.ok(r.confidence >= 0.7, text);
  }
  const typed = parser.parseIntentHeuristic("can you write hello");
  assert.equal(typed.action, "type_text");
  assert.equal(typed.args.text, "hello");
});

test("compound open-and-type plans use one confirmation string and never leave connectors in the app name", () => {
  const cases = [
    "open notepad and type hello",
    "open notepad and then type hello",
    "open notepad and in it type hello",
    "open notepad and inside it type hello",
    "open notepad and there type hello",
    "open notepad then type hello",
    "can you open notepad for me and write hello",
    "open notepad aur likho hello",
    "open notepad phir likho hello",
  ];
  for (const text of cases) {
    const r = parser.parseIntentHeuristic(text);
    assert.equal(r.action, "plan", text);
    assert.equal(r.steps[0].action, "open_app", text);
    assert.equal(r.steps[0].args.app, "notepad", text);
    assert.equal(parser.containsCommandConnector(r.steps[0].args.app), false, text);
    assert.equal(r.steps[1].action, "type_text", text);
    assert.equal(r.steps[1].args.text, "hello", text);
    assert.equal(
      parser.formatIntentForConfirm(r),
      "Open app: notepad, then Type text: hello",
      text
    );
  }
});

test("open_app heuristic rejects an app name that still contains a connector", () => {
  const r = parser.parseIntentHeuristic("open chrome and firefox");
  assert.notEqual(r.action, "open_app");
});

test("LLM open_app results with a connector in the app name are rejected", () => {
  const r = parser.parseIntentFromLlmResponse(
    '{"action":"open_app","app":"notepad and in it type hello","confidence":0.9}'
  );
  assert.equal(r.action, "none");
});

test("commandReferencesSelection is true only for this/selected/selection", () => {
  assert.equal(parser.commandReferencesSelection("open notepad"), false);
  assert.equal(parser.commandReferencesSelection("can you open notepad?"), false);
  assert.equal(parser.commandReferencesSelection("type this"), true);
  assert.equal(parser.commandReferencesSelection("rewrite the selected text"), true);
  assert.equal(parser.commandReferencesSelection("summarize the selection"), true);
});

test("parseIntent returns TIMEOUT when the completer times out", async () => {
  const err = new Error("Intent parser timed out");
  err.code = "TIMEOUT";
  const r = await parser.parseIntent("kindly fire up the calculator app please", {
    llmComplete: async () => {
      throw err;
    },
  });
  assert.equal(r.action, "none");
  assert.equal(r.errorCode, "TIMEOUT");
});
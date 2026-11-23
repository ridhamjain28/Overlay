const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyTypedClause,
  parseIntentHeuristic,
  formatIntentForConfirm,
} = require("../../src/helpers/overlay/commandMode/intentParser");

test("type hello is literal typing", () => {
  const cls = classifyTypedClause("type hello");
  assert.equal(cls.kind, "literal");
  assert.equal(cls.text, "hello");
  const r = parseIntentHeuristic("type hello");
  assert.equal(r.action, "type_text");
  assert.equal(r.args.text, "hello");
});

test("write hello is literal typing", () => {
  const r = parseIntentHeuristic("write hello");
  assert.equal(r.action, "type_text");
  assert.equal(r.args.text, "hello");
});

test("write an email to my boss saying I'm sick is compose", () => {
  const text = "write an email to my boss saying I'm sick";
  const cls = classifyTypedClause(text);
  assert.equal(cls.kind, "compose");
  const r = parseIntentHeuristic(text);
  assert.equal(r.action, "compose_text");
  assert.match(r.args.prompt, /email to my boss/i);
});

test("his exact sentence opens notepad then composes a letter, not literal typing", () => {
  const text = "open notepad and write a letter to my mother asking for a holiday to come home";
  const r = parseIntentHeuristic(text);
  assert.equal(r.action, "plan");
  assert.equal(r.steps[0].action, "open_app");
  assert.equal(r.steps[0].args.app, "notepad");
  assert.equal(r.steps[1].action, "compose_text");
  assert.match(r.steps[1].args.prompt, /letter to my mother asking for a holiday to come home/i);
  assert.match(formatIntentForConfirm(r), /Open app: notepad/i);
  assert.match(formatIntentForConfirm(r), /Write:/i);
  assert.doesNotMatch(formatIntentForConfirm(r), /Type text:/i);
});

test("notepad kholo aur ek letter likho maa ko is a compose plan", () => {
  const r = parseIntentHeuristic("notepad kholo aur ek letter likho maa ko");
  assert.equal(r.action, "plan");
  assert.equal(r.steps[0].action, "open_app");
  assert.equal(r.steps[0].args.app, "notepad");
  assert.equal(r.steps[1].action, "compose_text");
  assert.match(r.steps[1].args.prompt, /letter/i);
});

test("quoted and exact text stay literal", () => {
  assert.equal(parseIntentHeuristic('write "hello world"').action, "type_text");
  assert.equal(parseIntentHeuristic('write "hello world"').args.text, "hello world");
  assert.equal(parseIntentHeuristic("type exactly hello world").args.text, "hello world");
});

test("write an email alone stays chat, not compose or type", () => {
  const r = parseIntentHeuristic("can you write an email");
  assert.equal(r.action, "none");
});

test("open notepad and write hello stays a literal type plan", () => {
  const r = parseIntentHeuristic("open notepad and write hello");
  assert.equal(r.action, "plan");
  assert.equal(r.steps[1].action, "type_text");
  assert.equal(r.steps[1].args.text, "hello");
});
test("longer write clauses without a content noun go to the model (compose_text)", () => {
  const { intentFromTypedClause } = require("../../src/helpers/overlay/commandMode/typedClause");
  assert.equal(intentFromTypedClause("write good morning team").action, "compose_text");
  assert.equal(intentFromTypedClause("write hello").action, "type_text");
  assert.equal(intentFromTypedClause("type good morning team").action, "type_text");
});

test("open notepad and write a letter (no extra rest) is still compose", () => {
  const r = parseIntentHeuristic("open notepad and write a letter");
  assert.equal(r.action, "plan");
  assert.equal(r.steps[0].args.app, "notepad");
  assert.equal(r.steps[1].action, "compose_text");
});

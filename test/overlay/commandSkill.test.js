const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadCommandSkill,
  commandSkillSystemPrompt,
  INTENT_JSON_SCHEMA,
  SKILL_FILENAME,
} = require("../../src/helpers/overlay/commandMode/skillLoader");
const { buildIntentParseMessages } = require("../../src/helpers/overlay/commandMode/intentParser");

test("bundled command skill is versioned and contains the required rules and few-shots", () => {
  const skill = loadCommandSkill();
  assert.equal(skill.filename, SKILL_FILENAME);
  assert.equal(skill.version, "3");
  assert.match(skill.text, /Never drop a clause/i);
  assert.match(skill.text, /Output JSON only/i);
  assert.match(skill.text, /open edge and search for weather in pune/i);
  assert.match(skill.text, /literal versus compose/i);
  assert.match(skill.text, /calendar\/render/i);
  assert.match(skill.text, /compose_email/);
  assert.match(skill.text, /Do not say the system cannot manage calendars/i);
  // About 25 few-shots: count "User:" blocks
  const shots = skill.text.match(/^User:/gm) || [];
  assert.ok(shots.length >= 24, `expected ~25 few-shots, got ${shots.length}`);
  assert.equal(INTENT_JSON_SCHEMA.type, "object");
  assert.ok(INTENT_JSON_SCHEMA.properties.action.enum.includes("plan"));
  assert.ok(INTENT_JSON_SCHEMA.properties.steps);
});

test("intent parse system prompt is the skill text and stays byte-stable across calls", () => {
  const a = buildIntentParseMessages("open edge and search for weather in pune");
  const b = buildIntentParseMessages("type hello");
  assert.equal(a.system, commandSkillSystemPrompt());
  assert.equal(a.system, b.system);
  assert.match(a.user, /open edge and search for weather in pune/);
  assert.match(b.user, /type hello/);
  assert.notEqual(a.user, b.user);
});

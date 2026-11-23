const test = require("node:test");
const assert = require("node:assert/strict");
const { parseIntentHeuristic, parseIntent, buildIntentParseMessages } = require("../../src/helpers/overlay/commandMode/intentParser");
const { commandSkillSystemPrompt } = require("../../src/helpers/overlay/commandMode/skillLoader");
const { parseAppSkillIntent } = require("../../src/helpers/overlay/commandMode/appSkillMatcher");
const { createCommandDispatcher } = require("../../src/helpers/overlay/commandMode/actionDispatcher");
const { spotifySkill } = require("./fixtures/sampleCommandDb");

test("exact skill examples and aliases match without the LLM", () => {
  const skills = [spotifySkill()];
  const play = parseIntentHeuristic("play starboy on spotify", { skills });
  assert.equal(play.action, "app_action");
  assert.equal(play.args.appId, "spotify");
  assert.equal(play.args.actionId, "play_track");
  assert.equal(play.args.params.query, "starboy");
  assert.equal(play.source, "heuristic");
  const open = parseAppSkillIntent("open spotify", { skills });
  assert.equal(open.args.actionId, "launch");
});

test("play QUERY on spotify fills play_track without an exact example", () => {
  const skills = [spotifySkill()];
  const play = parseIntentHeuristic("play bohemian rhapsody on spotify", { skills });
  assert.equal(play.action, "app_action");
  assert.equal(play.args.actionId, "play_track");
  assert.equal(play.args.params.query, "bohemian rhapsody");
});

test("existing calendar and edge-search heuristics still win", () => {
  const skills = [spotifySkill()];
  const cal = parseIntentHeuristic('open google calendar and add an event on 24-11-2026 - "birthday party" from 5-7pm', { skills });
  assert.equal(cal.action, "open_url");
  assert.match(cal.args.url, /20261124T170000\/20261124T190000/);
  const edge = parseIntentHeuristic("open edge and search for weather in pune", { skills });
  assert.equal(edge.action, "open_url");
  assert.equal(edge.args.browser, "edge");
});

test("LLM prompt prefix stays byte-stable while skills are appended to the user message", () => {
  const a = buildIntentParseMessages("play starboy on spotify", { skills: [spotifySkill()], learned: [] });
  const b = buildIntentParseMessages("listen to queen on spotify", { skills: [spotifySkill()], learned: [] });
  assert.equal(a.system, commandSkillSystemPrompt());
  assert.equal(a.system, b.system);
  assert.match(a.user, /Available App Actions/);
  assert.match(a.user, /play starboy on spotify/);
});

test("app_action dispatcher fills a URI and confirms risky actions", async () => {
  const skills = [spotifySkill()];
  const opened = [];
  const confirms = [];
  const dispatcher = createCommandDispatcher({
    platform: "linux",
    autoRunTrusted: true,
    getAutoRunTrusted: () => true,
    getAppSkill: (appId) => skills.find((s) => s.appId === appId),
    openExternal: async (url) => opened.push(url),
    confirm: async (message) => {
      confirms.push(message);
      return false;
    },
  });
  const play = parseIntentHeuristic("play starboy on spotify", { skills });
  const result = await dispatcher.perform(play, { confirmed: true, autoRunTrusted: true });
  assert.equal(result.success, true);
  assert.equal(opened[0], "spotify:search:starboy");

  const riskySkill = {
    ...skills[0],
    actions: [{ id: "wipe", description: "confirm me", params: [], how: { type: "uri", template: "spotify:search:x" }, examples: [], risk: "confirm" }],
  };
  const risky = createCommandDispatcher({
    platform: "linux",
    autoRunTrusted: true,
    getAutoRunTrusted: () => true,
    getAppSkill: () => riskySkill,
    openExternal: async (url) => opened.push(url),
    confirm: async (message) => {
      confirms.push(message);
      return false;
    },
  });
  const denied = await risky.perform(
    { action: "app_action", args: { appId: "spotify", actionId: "wipe", params: {} } },
    { autoRunTrusted: true }
  );
  assert.equal(denied.code, "CANCELLED");
  assert.ok(confirms.length >= 1);
});

test("parseIntent still uses the heuristic when a skill example is exact", async () => {
  let llmCalls = 0;
  const result = await parseIntent("play starboy on spotify", {
    skills: [spotifySkill()],
    llmComplete: async () => {
      llmCalls += 1;
      return "{\"action\":\"none\"}";
    },
  });
  assert.equal(result.action, "app_action");
  assert.equal(llmCalls, 0);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBundledCommandDb } = require("../../src/helpers/overlay/commandMode/commandDb");

const REQUIRED_APP = ["appId", "name", "aliases", "match", "actions"];
const REQUIRED_ACTION = ["id", "description", "params", "how", "examples", "risk"];
const HOW_TYPES = new Set(["uri", "url", "cli", "keys"]);
const RISKS = new Set(["safe", "confirm"]);
const MATCH_KEYS = new Set(["exe", "aumidPrefix", "protocols", "nameRegex"]);
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)(?::[a-zA-Z0-9_]+)?\}/g;

test("bundled command DB has 3+ examples per action and every placeholder is declared", () => {
  const data = loadBundledCommandDb();
  const errors = [];
  let confirm = 0;
  let actionsN = 0;

  assert.equal(data.version, 1);
  assert.ok(data.updatedAt);
  assert.equal(data.remoteUrl, "");

  const appIds = new Set();
  for (const [i, app] of (data.apps || []).entries()) {
    for (const key of REQUIRED_APP) {
      if (app[key] == null) errors.push(`app[${i}] missing ${key}`);
    }
    if (!app?.appId) continue;
    const aid = app.appId;
    if (appIds.has(aid)) errors.push(`duplicate appId ${aid}`);
    appIds.add(aid);
    if (!Array.isArray(app.aliases) || !app.aliases.length) {
      errors.push(`${aid}: aliases must be a non-empty list`);
    }
    const match = app.match || {};
    for (const key of Object.keys(match)) {
      if (!MATCH_KEYS.has(key)) errors.push(`${aid}: unknown match key ${key}`);
    }
    for (const listKey of ["exe", "aumidPrefix", "protocols"]) {
      const vals = match[listKey];
      if (vals != null && !Array.isArray(vals)) {
        errors.push(`${aid}.match.${listKey} must be a list`);
      } else if (listKey === "exe" && Array.isArray(vals) && vals.some((v) => typeof v === "string" && v !== v.toLowerCase())) {
        errors.push(`${aid}.match.exe must be lowercase: ${vals}`);
      }
    }

    const actionIds = new Set();
    for (const act of app.actions || []) {
      actionsN += 1;
      const missing = REQUIRED_ACTION.filter((key) => act[key] == null);
      if (missing.length) {
        errors.push(`${aid}: action missing ${missing}: ${act.id}`);
        continue;
      }
      if (actionIds.has(act.id)) errors.push(`${aid}: duplicate action id ${act.id}`);
      actionIds.add(act.id);
      if (!RISKS.has(act.risk)) errors.push(`${aid}.${act.id}: bad risk ${act.risk}`);
      if (act.risk === "confirm") confirm += 1;
      const how = act.how || {};
      if (!HOW_TYPES.has(how.type)) errors.push(`${aid}.${act.id}: bad how.type ${how.type}`);
      const template = how.template;
      if (typeof template !== "string" || !template) {
        errors.push(`${aid}.${act.id}: empty template`);
        continue;
      }
      const declared = new Set((act.params || []).map((param) => param.name));
      for (const param of act.params || []) {
        if (!param.name || !param.type || typeof param.required !== "boolean") {
          errors.push(`${aid}.${act.id}: param missing fields ${JSON.stringify(param)}`);
        }
      }
      const used = new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
      const extra = [...used].filter((name) => !declared.has(name));
      const unused = [...declared].filter((name) => !used.has(name));
      if (extra.length) errors.push(`${aid}.${act.id}: template placeholders not in params: ${extra}`);
      if (unused.length) errors.push(`${aid}.${act.id}: params not used in template: ${unused}`);
      const examples = act.examples;
      if (!Array.isArray(examples) || examples.length < 3) {
        errors.push(`${aid}.${act.id}: needs 3+ examples, has ${Array.isArray(examples) ? examples.length : 0}`);
      }
      for (const example of examples || []) {
        if (!example || !("utterance" in example) || !("params" in example)) {
          errors.push(`${aid}.${act.id}: example missing utterance/params`);
          continue;
        }
        const unknown = Object.keys(example.params || {}).filter((key) => !declared.has(key));
        if (unknown.length) {
          errors.push(`${aid}.${act.id}: example params not declared: ${unknown} (${example.utterance})`);
        }
        const missingReq = (act.params || [])
          .filter((param) => param.required && !(param.name in (example.params || {})))
          .map((param) => param.name);
        if (missingReq.length) {
          errors.push(`${aid}.${act.id}: example missing required params ${missingReq} (${example.utterance})`);
        }
      }
    }
  }

  assert.ok(data.apps.length >= 40, `expected the shared ~40-app DB, got ${data.apps.length}`);
  assert.equal(errors.length, 0, errors.join("\n - "));
  assert.ok(actionsN >= 100, `expected a full action set, got ${actionsN}`);
  assert.equal(confirm, 1, "only placing a call should be confirm");
  const calendar = data.apps.find((app) => app.appId === "google-calendar");
  const create = calendar.actions.find((act) => act.id === "create-event");
  assert.equal(create.risk, "safe");
  assert.equal(create.autoSubmit.enabledByDefault, true);
  assert.equal(create.autoSubmit.keys, "control+s");
  const teams = data.apps.find((app) => app.appId === "microsoft-teams");
  const call = teams.actions.find((act) => act.id === "start-call");
  assert.equal(call.risk, "confirm");
});

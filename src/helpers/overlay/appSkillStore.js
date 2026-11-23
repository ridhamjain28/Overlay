// Local per-user command pack. Templates are copied from the bundled command
// DB; user edits (enabled flags, extra examples, custom actions) survive a rescan.

const fs = require("fs");
const path = require("path");
const { loadBundledCommandDb, findTemplatesForApp, listAlwaysAvailable } = require("./commandMode/commandDb");
const { slugify } = require("./appInventory");
const customSkillsService = require("./customSkillsService");

const CATALOG_NAME = "apps-catalog.json";
const APPS_DIRNAME = "apps";

function skillsRoot(baseDir) {
  return baseDir;
}

function catalogPath(baseDir) {
  return path.join(skillsRoot(baseDir), CATALOG_NAME);
}

function appsDir(baseDir) {
  return path.join(skillsRoot(baseDir), APPS_DIRNAME);
}

function skillPath(baseDir, appId) {
  return path.join(appsDir(baseDir), `${appId}.json`);
}

function ensureDir(dir, fsImpl) {
  fsImpl.mkdirSync(dir, { recursive: true });
}

function readJson(file, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data, fsImpl) {
  ensureDir(path.dirname(file), fsImpl);
  fsImpl.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function genericLaunchSkill(discovered) {
  const name = discovered.name || discovered.id;
  const how = discovered.protocols && discovered.protocols[0]
    ? { type: "uri", template: discovered.protocols[0] }
    : discovered.aumid
      ? { type: "uri", template: `shell:AppsFolder\\${discovered.aumid}` }
      : { type: "cli", template: "{target}" };
  return {
    appId: discovered.id || slugify(name),
    name,
    aliases: [name, slugify(name)].filter(Boolean),
    enabled: true,
    source: "generic",
    target: discovered.target || "",
    aumid: discovered.aumid || "",
    protocols: discovered.protocols || [],
    actions: [
      {
        id: "launch",
        description: `Open ${name}`,
        params: [],
        how,
        examples: [{ utterance: `open ${name}`, params: {} }],
        risk: "safe",
        source: "generic",
      },
    ],
  };
}

function skillFromTemplate(template, discovered = {}) {
  return {
    appId: template.appId,
    name: template.name,
    aliases: Array.from(new Set([...(template.aliases || []), discovered.name].filter(Boolean))),
    enabled: true,
    source: "db",
    kind: template.kind || (template.alwaysAvailable ? "web" : "app"),
    alwaysAvailable: template.alwaysAvailable === true,
    target: discovered.target || "",
    aumid: discovered.aumid || "",
    protocols: Array.from(new Set([...(template.match?.protocols || []).map((p) => (p.endsWith(":") ? p : `${p}:`)), ...((discovered.protocols) || [])])),
    actions: (template.actions || []).map((action) => ({ ...action, source: "db" })),
  };
}

function mergeActions(existingActions = [], incomingActions = []) {
  const byId = new Map();
  for (const action of incomingActions) {
    if (action && action.id) byId.set(action.id, { ...action });
  }
  for (const action of existingActions) {
    if (!action || !action.id) continue;
    const incoming = byId.get(action.id);
    if (!incoming) {
      if (action.source === "user" || action.userEdited) byId.set(action.id, action);
      continue;
    }
    const examplesByUtterance = new Map();
    for (const ex of incoming.examples || []) {
      if (ex && ex.utterance) examplesByUtterance.set(String(ex.utterance).toLowerCase(), ex);
    }
    for (const ex of action.examples || []) {
      const key = String(ex?.utterance || "").toLowerCase();
      if (key && !examplesByUtterance.has(key)) examplesByUtterance.set(key, ex);
    }
    byId.set(action.id, {
      ...incoming,
      enabled: action.enabled != null ? action.enabled : incoming.enabled,
      how: action.userEditedHow ? action.how : incoming.how,
      userEditedHow: action.userEditedHow === true,
      examples: Array.from(examplesByUtterance.values()),
      source: incoming.source || action.source,
    });
  }
  return Array.from(byId.values());
}

function mergeCustomActions(existingActions = [], customActions = []) {
  const byId = new Map();
  for (const act of existingActions) {
    if (act && act.id) byId.set(act.id, { ...act });
  }
  for (const act of customActions) {
    if (act && act.id) {
      const existing = byId.get(act.id);
      byId.set(act.id, existing ? { ...existing, ...act, source: "custom" } : { ...act, source: "custom" });
    }
  }
  return Array.from(byId.values());
}

function mergeSkill(existing, incoming) {
  if (!existing) return incoming;
  const isCustomIncoming = incoming.source === "custom";
  return {
    ...incoming,
    enabled: existing.enabled != null ? existing.enabled : incoming.enabled,
    aliases: Array.from(new Set([...(incoming.aliases || []), ...(existing.aliases || [])])),
    target: incoming.target || existing.target,
    aumid: incoming.aumid || existing.aumid,
    protocols: Array.from(new Set([...(incoming.protocols || []), ...(existing.protocols || [])])),
    actions: isCustomIncoming
      ? mergeCustomActions(existing.actions, incoming.actions)
      : mergeActions(existing.actions, incoming.actions),
  };
}

function readSkill(baseDir, appId, fsImpl = fs) {
  const base = readJson(skillPath(baseDir, appId), fsImpl);
  const customSkills = customSkillsService.loadCustomSkills(baseDir, fsImpl);
  const custom = customSkills.find((s) => s && s.appId === appId);
  if (!custom) return base;
  if (!base) return custom;
  return mergeSkill(base, custom);
}

function writeSkill(baseDir, skill, fsImpl = fs) {
  writeJson(skillPath(baseDir, skill.appId), skill, fsImpl);
  return skill;
}

function listLocalSkills(baseDir, fsImpl = fs) {
  const dir = appsDir(baseDir);
  let names = [];
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    names = [];
  }
  const localSkills = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(dir, name), fsImpl))
    .filter(Boolean);

  const customSkills = customSkillsService.loadCustomSkills(baseDir, fsImpl);
  if (!customSkills.length) return localSkills;

  const byId = new Map(localSkills.map((s) => [s.appId, s]));
  for (const custom of customSkills) {
    if (!custom || !custom.appId) continue;
    const existing = byId.get(custom.appId);
    if (existing) {
      byId.set(custom.appId, mergeSkill(existing, custom));
    } else {
      byId.set(custom.appId, custom);
    }
  }
  return Array.from(byId.values());
}

function buildPackFromScan({ catalogApps, db, baseDir, fsImpl = fs, now = new Date() }) {
  ensureDir(appsDir(baseDir), fsImpl);
  const usedIds = new Set();
  const pack = [];

  const addSkill = (incoming) => {
    const existing = readSkill(baseDir, incoming.appId, fsImpl);
    const merged = mergeSkill(existing, incoming);
    writeSkill(baseDir, merged, fsImpl);
    usedIds.add(merged.appId);
    pack.push(merged);
  };

  for (const discovered of catalogApps || []) {
    const templates = findTemplatesForApp(db, discovered);
    if (templates.length) {
      for (const template of templates) addSkill(skillFromTemplate(template, discovered));
    } else {
      addSkill(genericLaunchSkill(discovered));
    }
  }
  for (const template of listAlwaysAvailable(db)) {
    if (!usedIds.has(template.appId)) addSkill(skillFromTemplate(template, {}));
  }

  const catalog = {
    version: 1,
    scannedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    dbVersion: db.version,
    apps: pack.map((skill) => ({
      id: skill.appId,
      name: skill.name,
      aliases: skill.aliases,
      type: skill.kind || skill.source,
      target: skill.target,
      aumid: skill.aumid,
      protocols: skill.protocols,
      source: skill.source,
      enabled: skill.enabled !== false,
      ready: skill.source === "db" || skill.alwaysAvailable === true,
    })),
  };
  writeJson(catalogPath(baseDir), catalog, fsImpl);
  return { catalog, skills: pack };
}

function summarizePack(catalog) {
  const apps = catalog?.apps || [];
  const ready = apps.filter((app) => app.ready).length;
  return { count: apps.length, ready };
}

function setSkillEnabled(baseDir, appId, enabled, fsImpl = fs, actionId) {
  const skill = readSkill(baseDir, appId, fsImpl);
  if (!skill) return null;
  const on = enabled === true;
  if (actionId) {
    const action = (skill.actions || []).find((item) => item.id === actionId);
    if (!action) return null;
    action.enabled = on;
  } else {
    skill.enabled = on;
  }
  writeSkill(baseDir, skill, fsImpl);
  const catalog = readJson(catalogPath(baseDir), fsImpl);
  if (catalog && Array.isArray(catalog.apps) && !actionId) {
    catalog.apps = catalog.apps.map((app) =>
      app.id === appId ? { ...app, enabled: skill.enabled } : app
    );
    writeJson(catalogPath(baseDir), catalog, fsImpl);
  }
  return skill;
}

function toScanResult(catalog, skills = []) {
  if (!catalog) return null;
  const byId = new Map((skills || []).map((skill) => [skill.appId, skill]));
  const apps = (catalog.apps || []).map((app) => {
    const skill = byId.get(app.id || app.appId);
    const actions = skill?.actions || [];
    return {
      appId: app.id || app.appId,
      name: app.name || skill?.name || "",
      matched: app.ready === true || skill?.source === "db",
      actionsCount: actions.length,
      enabled: (skill?.enabled ?? app.enabled) !== false,
      source: app.source || skill?.source || "generic",
    };
  });
  return {
    scannedAt: catalog.scannedAt || null,
    found: apps.length,
    withCommands: apps.filter((app) => app.matched).length,
    apps,
  };
}

function getCatalog(baseDir, fsImpl = fs) {
  return readJson(catalogPath(baseDir), fsImpl);
}

module.exports = {
  CATALOG_NAME,
  catalogPath,
  appsDir,
  skillPath,
  genericLaunchSkill,
  skillFromTemplate,
  mergeSkill,
  mergeActions,
  buildPackFromScan,
  summarizePack,
  setSkillEnabled,
  toScanResult,
  listLocalSkills,
  readSkill,
  writeSkill,
  getCatalog,
};

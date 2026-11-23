// Service for user-editable custom command skills (%APPDATA%\Overlay\skills\custom.json).
// Loads, validates, saves, and hot-reloads custom user skills with clear errors.
// Bad entries are skipped so the app never crashes.

const fs = require("fs");
const path = require("path");

const CUSTOM_FILENAME = "custom.json";
const TEMPLATE_PATH = path.join(__dirname, "commandMode", "skills", "custom.template.json");

function getCustomPath(baseDir) {
  return path.join(baseDir, CUSTOM_FILENAME);
}

function getTemplateText() {
  try {
    return fs.readFileSync(TEMPLATE_PATH, "utf8");
  } catch {
    return JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        apps: [],
      },
      null,
      2
    );
  }
}

/**
 * Validates a single action. Returns array of error messages.
 */
function validateAction(action, appIdentifier, actionIndex) {
  const errors = [];
  const prefix = `App "${appIdentifier}" action #${actionIndex + 1}`;

  if (!action || typeof action !== "object") {
    errors.push(`${prefix} is not an object`);
    return errors;
  }

  if (!action.id || typeof action.id !== "string" || !action.id.trim()) {
    errors.push(`${prefix} is missing a required "id"`);
  }

  if (!action.description || typeof action.description !== "string" || !action.description.trim()) {
    errors.push(`${prefix} is missing a required "description"`);
  }

  if (!action.how || typeof action.how !== "object") {
    errors.push(`${prefix} is missing a required "how" object`);
  } else {
    if (!action.how.type || typeof action.how.type !== "string") {
      errors.push(`${prefix} "how.type" must be a string (e.g. cli, uri, shell, shortcut)`);
    }
    if (!action.how.template || typeof action.how.template !== "string" || !action.how.template.trim()) {
      errors.push(`${prefix} "how.template" is required`);
    }
  }

  if (action.risk && action.risk !== "safe" && action.risk !== "confirm") {
    errors.push(`${prefix} "risk" must be either "safe" or "confirm"`);
  }

  if (action.params && !Array.isArray(action.params)) {
    errors.push(`${prefix} "params" must be an array`);
  }

  if (action.examples && !Array.isArray(action.examples)) {
    errors.push(`${prefix} "examples" must be an array`);
  }

  return errors;
}

/**
 * Validates a single app skill. Returns { errors, app: normalizedApp | null }.
 */
function validateApp(app, index) {
  const errors = [];
  const prefix = `App #${index + 1}`;

  if (!app || typeof app !== "object") {
    return { errors: [`${prefix} is not an object`], app: null };
  }

  const appIdentifier = app.name || app.appId || `[index ${index}]`;

  if (!app.appId || typeof app.appId !== "string" || !app.appId.trim()) {
    errors.push(`${prefix} (${appIdentifier}) is missing a required "appId"`);
  } else if (!/^[a-z0-9_-]+$/i.test(app.appId)) {
    errors.push(
      `${prefix} "${app.appId}" has invalid appId format (use alphanumeric, dash, or underscore)`
    );
  }

  if (!app.name || typeof app.name !== "string" || !app.name.trim()) {
    errors.push(`${prefix} (${appIdentifier}) is missing a required "name"`);
  }

  if (app.aliases && !Array.isArray(app.aliases)) {
    errors.push(`${prefix} (${appIdentifier}) "aliases" must be an array of strings`);
  }

  const validActions = [];
  if (app.actions) {
    if (!Array.isArray(app.actions)) {
      errors.push(`${prefix} (${appIdentifier}) "actions" must be an array`);
    } else {
      app.actions.forEach((act, actIdx) => {
        const actErrors = validateAction(act, appIdentifier, actIdx);
        if (actErrors.length > 0) {
          errors.push(...actErrors);
        } else {
          validActions.push({
            ...act,
            id: String(act.id).trim(),
            description: String(act.description).trim(),
            params: Array.isArray(act.params) ? act.params : [],
            how: {
              type: String(act.how.type).trim(),
              template: String(act.how.template).trim(),
            },
            examples: Array.isArray(act.examples) ? act.examples : [],
            risk: act.risk === "confirm" ? "confirm" : "safe",
            enabled: act.enabled !== false,
          });
        }
      });
    }
  }

  if (!app.appId || !app.name) {
    return { errors, app: null };
  }

  const normalizedApp = {
    appId: String(app.appId).trim(),
    name: String(app.name).trim(),
    aliases: Array.isArray(app.aliases) ? app.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
    enabled: app.enabled !== false,
    source: "custom",
    kind: app.kind || "custom",
    match: app.match || {},
    actions: validActions,
  };

  return { errors, app: normalizedApp };
}

/**
 * Validates custom skills data (text or parsed object).
 * Returns { ok: boolean, errors: string[], apps: AppSkill[], validApps: AppSkill[] }.
 */
function validateCustomSkillsData(data) {
  let parsed;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      return {
        ok: false,
        errors: [`JSON Syntax Error: ${err.message}`],
        apps: [],
        validApps: [],
      };
    }
  } else {
    parsed = data;
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      errors: ["Root content must be a JSON object or array of apps"],
      apps: [],
      validApps: [],
    };
  }

  const appsRaw = Array.isArray(parsed) ? parsed : Array.isArray(parsed.apps) ? parsed.apps : null;
  if (!appsRaw) {
    return {
      ok: false,
      errors: ['Expected an "apps" array in root object or a top-level array of apps'],
      apps: [],
      validApps: [],
    };
  }

  const allErrors = [];
  const validApps = [];

  appsRaw.forEach((app, index) => {
    const { errors, app: normApp } = validateApp(app, index);
    if (errors.length > 0) {
      allErrors.push(...errors);
    }
    if (normApp) {
      validApps.push(normApp);
    }
  });

  return {
    ok: allErrors.length === 0,
    errors: allErrors,
    apps: validApps,
    validApps,
  };
}

/**
 * Loads valid custom skills from %APPDATA%\Overlay\skills\custom.json.
 * Skips bad entries without throwing; never crashes.
 */
function loadCustomSkills(baseDir, fsImpl = fs) {
  const filePath = getCustomPath(baseDir);
  try {
    if (!fsImpl.existsSync(filePath)) {
      return [];
    }
    const text = fsImpl.readFileSync(filePath, "utf8");
    const result = validateCustomSkillsData(text);
    return result.validApps;
  } catch {
    return [];
  }
}

/**
 * IPC handler: customGet() => { text, path, errors[] }
 */
function getCustomSkills(baseDir, fsImpl = fs) {
  const filePath = getCustomPath(baseDir);
  let text = "";
  try {
    if (fsImpl.existsSync(filePath)) {
      text = fsImpl.readFileSync(filePath, "utf8");
    } else {
      text = getTemplateText();
      fsImpl.mkdirSync(baseDir, { recursive: true });
      fsImpl.writeFileSync(filePath, text, "utf8");
    }
  } catch (err) {
    return {
      text: getTemplateText(),
      path: filePath,
      errors: [`Failed to read custom skills file: ${err.message}`],
    };
  }

  const validation = validateCustomSkillsData(text);
  return {
    text,
    path: filePath,
    errors: validation.errors,
  };
}

/**
 * IPC handler: customValidate(text) => { ok, errors[] }
 */
function validateCustomSkillsText(text) {
  const result = validateCustomSkillsData(text);
  return {
    ok: result.ok,
    errors: result.errors,
  };
}

/**
 * IPC handler: customSave(text) => { ok, errors[] }
 */
function saveCustomSkills(baseDir, text, fsImpl = fs) {
  const filePath = getCustomPath(baseDir);
  const validation = validateCustomSkillsData(text);

  if (!validation.ok && validation.errors.some((e) => e.startsWith("JSON Syntax Error"))) {
    return {
      ok: false,
      errors: validation.errors,
    };
  }

  try {
    fsImpl.mkdirSync(baseDir, { recursive: true });
    fsImpl.writeFileSync(filePath, String(text).trim() + "\n", "utf8");
    return {
      ok: true,
      errors: validation.errors,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [`Failed to write to ${filePath}: ${err.message}`],
    };
  }
}

/**
 * IPC handler: customOpenFile()
 */
async function openCustomFile(baseDir, shell, fsImpl = fs) {
  const filePath = getCustomPath(baseDir);
  if (!fsImpl.existsSync(filePath)) {
    fsImpl.mkdirSync(baseDir, { recursive: true });
    fsImpl.writeFileSync(filePath, getTemplateText(), "utf8");
  }
  if (shell && typeof shell.openPath === "function") {
    await shell.openPath(filePath);
  }
}

module.exports = {
  CUSTOM_FILENAME,
  getCustomPath,
  getTemplateText,
  validateCustomSkillsData,
  validateCustomSkillsText,
  loadCustomSkills,
  getCustomSkills,
  saveCustomSkills,
  openCustomFile,
};

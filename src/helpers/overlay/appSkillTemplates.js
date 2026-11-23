// Fill skill action templates. URI/URL values are encoded; CLI args are passed
// as a literal argv list (never interpolated into a shell string).

const path = require("path");

const SAFE_KEYS = new Set([
  "mediaplaypause",
  "medianexttrack",
  "mediaprevioustrack",
  "mediastop",
  "control+shift+p",
  "control+p",
  "control+s",
  "control+n",
  "control+t",
  "control+w",
  "control+l",
  "alt+tab",
  "alt+f4",
]);

const CLI_UNSAFE = /[\r\n\0|&;$`<>]/;

function valueOf(params, name) {
  if (!params || typeof params !== "object") return "";
  const value = params[name];
  return value == null ? "" : String(value);
}

function encodeValue(value) {
  return encodeURIComponent(String(value ?? ""));
}

function fillTemplateString(template, params, { encode = false } = {}) {
  const source = String(template || "");
  return source.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}]+)?\}/g, (all, name) => {
    const raw = valueOf(params, name);
    return encode ? encodeValue(raw) : raw;
  }).replace(/encodeURIComponent\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g, (_, name) =>
    encodeValue(valueOf(params, name))
  );
}

function validateParams(action, params = {}) {
  const missing = [];
  for (const param of action?.params || []) {
    if (param && param.required && !String(params[param.name] ?? "").trim()) {
      missing.push(param.name);
    }
  }
  if (missing.length) {
    return { ok: false, error: `Missing required parameter: ${missing.join(", ")}` };
  }
  return { ok: true };
}

function sanitizeCliArg(value) {
  const text = String(value ?? "");
  if (CLI_UNSAFE.test(text)) {
    throw new Error("CLI argument contains unsafe characters");
  }
  return text;
}

function splitCliTemplate(template, params) {
  const tokens = [];
  const source = String(template || "");
  const re = /"([^"]*)"|'([^']*)'|\{([a-zA-Z_][a-zA-Z0-9_]*)\}|[^\s]+/g;
  let match;
  while ((match = re.exec(source))) {
    if (match[3]) tokens.push(sanitizeCliArg(valueOf(params, match[3])));
    else if (match[1] != null) tokens.push(sanitizeCliArg(fillTemplateString(match[1], params)));
    else if (match[2] != null) tokens.push(sanitizeCliArg(fillTemplateString(match[2], params)));
    else tokens.push(sanitizeCliArg(fillTemplateString(match[0], params)));
  }
  return tokens;
}

function fillActionTemplate(action, params = {}, context = {}) {
  const check = validateParams(action, params);
  if (!check.ok) return check;
  const merged = { ...params };
  if (context.target && merged.target == null) merged.target = context.target;
  const typ = String(action?.how?.type || "");
  const template = action?.how?.template || "";
  if (typ === "url" || typ === "uri") {
    const filled = fillTemplateString(template, merged, { encode: typ === "url" || typ === "uri" });
    // Path-style URI templates still need slashes in file paths; encode segments
    // but restore a leading scheme and Windows drive colon after encoding.
    return { ok: true, type: typ, value: restoreUri(template, merged) };
  }
  if (typ === "cli") {
    try {
      const argv = splitCliTemplate(template, merged);
      const exe = argv[0] || "";
      if (!exe) return { ok: false, error: "CLI template is missing an executable" };
      return { ok: true, type: "cli", exe, args: argv.slice(1) };
    } catch (error) {
      return { ok: false, error: error.message || "CLI argument contains unsafe characters" };
    }
  }
  if (typ === "keys") {
    const combo = String(fillTemplateString(template, merged)).trim();
    if (!SAFE_KEYS.has(combo.toLowerCase())) {
      return { ok: false, error: `Keyboard shortcut "${combo}" is not allowed` };
    }
    return { ok: true, type: "keys", value: combo };
  }
  return { ok: false, error: `Unknown action type "${typ}"` };
}

function restoreUri(template, params) {
  // Encode each placeholder, but leave the static scheme/path punctuation alone.
  return String(template || "").replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => {
    const raw = valueOf(params, name);
    if (name === "target" || name === "path") {
      // File paths used in vscode://file/C:/... should keep separators.
      return String(raw).replace(/\\/g, "/").split("/").map((part, i) => {
        if (i === 0 && /^[a-zA-Z]:$/.test(part)) return part;
        return encodeURIComponent(part);
      }).join("/");
    }
    if (name === "page" && /^[a-z0-9-]+$/i.test(raw)) return raw;
    if (name === "dates" && /^[0-9T/]*$/.test(raw)) return raw;
    return encodeURIComponent(raw);
  }).replace(/encodeURIComponent\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g, (_, name) =>
    encodeURIComponent(valueOf(params, name))
  );
}

function isSafeKeyCombo(combo) {
  return SAFE_KEYS.has(String(combo || "").toLowerCase());
}

module.exports = {
  fillTemplateString,
  fillActionTemplate,
  validateParams,
  sanitizeCliArg,
  isSafeKeyCombo,
  SAFE_KEYS,
};

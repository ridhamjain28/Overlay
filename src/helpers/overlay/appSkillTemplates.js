// Fill skill action templates. URI/URL values are encoded; CLI args are passed
// as a literal argv list (never interpolated into a shell string).
// Office ofe/ofv document URIs keep ":" and "/" unescaped. `{param:raw}`
// skips encoding. Calendar {start}/{end} reuse the compact local-time parser.

const {
  formatLocalStamp,
  parseEventDate,
  parseEventTimeRange,
} = require("./commandMode/webApps");

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
function placeholderRe() {
  return /\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]+))?\}/g;
}
const COMPACT_STAMP_RE = /^\d{8}T\d{6}Z?$/;
const OFFICE_DOC_URI_RE = /:of[ev]\|u\|\{[a-zA-Z_][a-zA-Z0-9_]*(?::[^}]+)?\}/i;

function valueOf(params, name) {
  if (!params || typeof params !== "object") return "";
  const value = params[name];
  return value == null ? "" : String(value);
}

function encodeValue(value) {
  return encodeURIComponent(String(value ?? ""));
}

function encodeOfficeUri(value) {
  // Office URI Schemes §1.3: leave ":" and "/" unescaped in the document URI.
  return encodeValue(value).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
}

function isOfficeDocumentUriTemplate(template) {
  return OFFICE_DOC_URI_RE.test(String(template || ""));
}

function isCompactStamp(value) {
  return COMPACT_STAMP_RE.test(String(value || "").trim());
}

function coerceCalendarStamps(params = {}, { utterance, now = new Date() } = {}) {
  const next = { ...params };
  if (isCompactStamp(next.start) && isCompactStamp(next.end)) return next;
  const text = String(utterance || "").trim() || [next.title, next.start, next.end].filter(Boolean).join(" ");
  if (!text) return next;
  const date = parseEventDate(text, now);
  const range = parseEventTimeRange(text);
  if (!date || !range) return next;
  if (!isCompactStamp(next.start)) {
    next.start = formatLocalStamp({ ...date, ...range.start, second: 0 });
  }
  if (!isCompactStamp(next.end)) {
    next.end = formatLocalStamp({ ...date, ...range.end, second: 0 });
  }
  return next;
}

function modifierOf(rawModifier, { encode = false, office = false, name = "" } = {}) {
  const mode = String(rawModifier || "").trim().toLowerCase();
  if (mode) return mode;
  if (office && name === "url") return "office";
  if (encode) return "encode";
  return "raw";
}

function applyEncoding(value, mode, name) {
  if (mode === "raw") return String(value ?? "");
  if (mode === "office") return encodeOfficeUri(value);
  if (mode === "path" || name === "target" || name === "path") {
    return String(value ?? "")
      .replace(/\\/g, "/")
      .split("/")
      .map((part, i) => {
        if (i === 0 && /^[a-zA-Z]:$/.test(part)) return part;
        return encodeURIComponent(part);
      })
      .join("/");
  }
  if ((name === "page" && /^[a-z0-9-]+$/i.test(value)) ||
      ((name === "dates" || name === "start" || name === "end") && /^[0-9T/Z]*$/.test(value))) {
    return String(value ?? "");
  }
  return encodeValue(value);
}

function fillTemplateString(template, params, { encode = false, office = false } = {}) {
  const source = String(template || "");
  return source
    .replace(placeholderRe(), (all, name, modifier) => {
      const raw = valueOf(params, name);
      const mode = modifierOf(modifier, { encode, office, name });
      return encode || mode !== "raw" || modifier ? applyEncoding(raw, mode, name) : raw;
    })
    .replace(/encodeURIComponent\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g, (_, name) =>
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
  const re = /"([^"]*)"|'([^']*)'|\{([a-zA-Z_][a-zA-Z0-9_]*)(?::[^}]+)?\}|[^\s]+/g;
  let match;
  while ((match = re.exec(source))) {
    if (match[3]) tokens.push(sanitizeCliArg(valueOf(params, match[3])));
    else if (match[1] != null) tokens.push(sanitizeCliArg(fillTemplateString(match[1], params)));
    else if (match[2] != null) tokens.push(sanitizeCliArg(fillTemplateString(match[2], params)));
    else tokens.push(sanitizeCliArg(fillTemplateString(match[0], params)));
  }
  return tokens;
}

function actionNeedsCalendarStamps(action) {
  const names = new Set((action?.params || []).map((param) => param?.name));
  const template = String(action?.how?.template || "");
  return names.has("start") || names.has("end") || /\{start\}|\{end\}/.test(template);
}

function fillActionTemplate(action, params = {}, context = {}) {
  const check = validateParams(action, params);
  if (!check.ok) return check;
  let merged = { ...params };
  if (context.target && merged.target == null) merged.target = context.target;
  if (actionNeedsCalendarStamps(action)) {
    merged = coerceCalendarStamps(merged, { utterance: context.utterance || params.utterance, now: context.now });
  }
  const typ = String(action?.how?.type || "");
  const template = action?.how?.template || "";
  const rawAll = action?.how?.raw === true;
  const office = isOfficeDocumentUriTemplate(template);
  if (typ === "url" || typ === "uri") {
    const filled = restoreUri(template, merged, { rawAll, office });
    return { ok: true, type: typ, value: filled };
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

function restoreUri(template, params, { rawAll = false, office = false } = {}) {
  // Encode each placeholder, but leave the static scheme/path punctuation alone.
  return String(template || "")
    .replace(placeholderRe(), (_, name, modifier) => {
      const raw = valueOf(params, name);
      if (rawAll) return String(raw);
      const mode = modifierOf(modifier, { encode: true, office, name });
      return applyEncoding(raw, mode, name);
    })
    .replace(/encodeURIComponent\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g, (_, name) =>
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
  encodeOfficeUri,
  isOfficeDocumentUriTemplate,
  coerceCalendarStamps,
  isCompactStamp,
  SAFE_KEYS,
};

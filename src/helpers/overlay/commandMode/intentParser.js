// Overlay Command mode: turn spoken or typed text into one structured intent.
// Pure functions — no Electron, no network. The LLM step is injected.

const { classifyTypedClause, intentFromTypedClause } = require("./typedClause");

const COMMAND_ACTIONS = ["open_app", "open_url", "run_command", "type_text", "compose_text", "guide"];

const URL_PROTOCOL = /^(https?:\/\/)/i;
const BARE_SITE =
  /^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#][^\s]*)?$/i;
const HAS_URL = /\bhttps?:\/\/[^\s]+/i;
const HAS_BARE_SITE =
  /\b(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co|in|uk|edu|gov)(?:[/:?#][^\s]*)?\b/i;

const CHAT_PATTERNS = [
  /^(what|what's|whats|why|who|whom|whose|when|where is the capital|how does|how do i know|how can i learn|explain|summarize|summarise|translate|tell me about|help me understand|write (me )?(an? |some )?(email|essay|letter|poem|story)|draft|prove|compare)\b/i,
  /^(can you (explain|help me understand|summarize|summarise|write (me )?(an? |some )?(email|essay|letter|poem|story)))\b/i,
];

const GUIDE_PATTERNS = [
  /^(where(?:'s| is)|point (?:to|at)|show me|find(?: me)?|locate|highlight|which(?: one)? is) (?:the )?(?:(.+?)(?:\s+button|\s+icon|\s+tab|\s+link|\s+menu|\s+control)?)$/i,
  /^(?:click|press|tap|hit)\s+(?:the\s+)?(.+)$/i,
  /^(?:kaise|kahan|kahaan)\s+(?:hai|he|hain)\b/i,
];

const OPEN_APP_PATTERNS = [
  /^(?:please\s+)?(?:open|launch|start|run|kholo|khol do|chalao)\s+(?:the\s+app\s+|app\s+|the\s+)?(.+)$/i,
];

const OPEN_URL_PATTERNS = [
  /^(?:please\s+)?(?:open|go to|goto|visit|browse|navigate to|take me to|new tab(?: for)?|open(?: a)?(?: new)? tab(?: (?:to|for|with))?)\s+(.+)$/i,
];

const TYPE_PATTERNS = [
  /^(?:please\s+)?(?:type|write|enter|paste|likho|likh do)\s+(?:this\s*)?[:：]\s*(.+)$/i,
  /^(?:please\s+)?(?:type|write|enter|paste|likho|likh do)\s+(?:the text\s+)?["“](.+)["”]\s*$/i,
  /^(?:please\s+)?(?:type|write|enter|paste|likho|likh do)\s+(.+)$/i,
];

const RUN_PATTERNS = [
  /^(?:please\s+)?(?:run|execute|shell|cmd(?: command)?|powershell)\s+(?:the\s+command\s*)?[:：]?\s*(.+)$/i,
  /^(?:please\s+)?(?:run|execute)\s+(?:this\s+)?(?:in(?: the)? (?:terminal|shell|cmd|powershell)\s*[:：]?\s*)(.+)$/i,
  /^(?:in(?: the)? (?:terminal|shell|command prompt|cmd|powershell)[,:]?\s+)(.+)$/i,
];

// Connectors that split "open X and type Y". An open_app name must never
// include one of these — split into a plan, or reject the open_app parse.
const COMPOUND_CONNECTOR_RE =
  /(?:and(?:\s+then)?|then|and\s+in(?:side)?\s+it|and\s+there|aur|phir)/i;
const COMPOUND_SPLIT_RE = new RegExp(
  "^(?:open|launch|start|kholo|khol do|chalao)\\s+(.+?)\\s+(?:" +
    COMPOUND_CONNECTOR_RE.source +
    ")\\s+(?:then\\s+)?(?:please\\s+)?(?:type|write|enter|paste|likho|likh do)\\s+(?:this\\s*)?[:\\uFF1A]?\\s*(.+)$",
  "i"
);
const HINGLISH_OPEN_RE = /^(.+?)\s+(kholo|khol do|khol dena|chalao|chala do)\s*$/i;
const LEADING_WRAPPER_RE =
  /^(?:(?:please|pls|plz|hey overlay|ok overlay|okay overlay|overlay,|overlay\s*[,:]?|can you|could you|would you|will you|can u|could u|would u)\s+)+/i;
const TRAILING_WRAPPER_RE = /(?:\s+(?:for me|please|pls|plz|now))+$/i;

function trimText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(value) {
  const t = trimText(value);
  const m = t.match(/^["“'](.+)["”']$/);
  return m ? m[1].trim() : t;
}

function stripCommandWrappers(text) {
  let value = trimText(text);
  let prev;
  do {
    prev = value;
    value = value.replace(/[?!.,]+$/g, "").trim();
    value = value.replace(TRAILING_WRAPPER_RE, "").trim();
    value = value.replace(LEADING_WRAPPER_RE, "").trim();
    value = value.replace(/\s+for me\s+and\s+/i, " and ").trim();
  } while (value !== prev);
  return value;
}

function containsCommandConnector(value) {
  return new RegExp("\\b" + COMPOUND_CONNECTOR_RE.source + "\\b", "i").test(trimText(value));
}

function commandReferencesSelection(text) {
  return /\b(this|selected|selection)\b/i.test(String(text || ""));
}

function cleanAppName(raw) {
  return stripWrappingQuotes(raw)
    .replace(/^(the\s+)?(app|application|program|software)\s+/i, "")
    .replace(/\s+(app|application|program)$/i, "")
    .replace(/[?!.,]+$/g, "")
    .trim();
}

function toHttpsUrl(raw) {
  const value = stripWrappingQuotes(raw).replace(/[.,;!?)]+$/, "");
  if (!value) return null;
  const fromText = value.match(HAS_URL);
  const candidate = fromText ? fromText[0] : value.replace(/^(https?:\/\/)?/i, (p) => p);
  const withProto = URL_PROTOCOL.test(candidate)
    ? candidate
    : BARE_SITE.test(candidate) || HAS_BARE_SITE.test(candidate)
      ? `https://${candidate.replace(/^www\./i, (w) => w)}`
      : null;
  if (!withProto) return null;
  try {
    const url = new URL(withProto.startsWith("http") ? withProto : `https://${withProto}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function looksLikeChat(text) {
  const t = trimText(text);
  if (!t) return true;
  return CHAT_PATTERNS.some((re) => re.test(t));
}

function looksImperative(text) {
  return /^(please\s+)?(open|launch|start|run|execute|type|write|enter|paste|go to|visit|browse|click|press|show|find|point|locate|kholo|chalao|likho)\b/i.test(
    trimText(text)
  );
}

function parseOpenUrl(text) {
  const direct = toHttpsUrl(text);
  if (direct && /^\s*https?:\/\//i.test(text)) {
    return { action: "open_url", args: { url: direct }, confidence: 0.95 };
  }
  for (const re of OPEN_URL_PATTERNS) {
    const m = trimText(text).match(re);
    if (!m) continue;
    const url = toHttpsUrl(m[1]);
    if (url) return { action: "open_url", args: { url }, confidence: 0.92 };
  }
  // "open youtube.com" — the open-app patterns also match; prefer URL when it is one.
  const openApp = trimText(text).match(OPEN_APP_PATTERNS[0]);
  if (openApp) {
    const url = toHttpsUrl(openApp[1]);
    if (url) return { action: "open_url", args: { url }, confidence: 0.9 };
  }
  return null;
}

function parseOpenApp(text) {
  for (const re of OPEN_APP_PATTERNS) {
    const m = trimText(text).match(re);
    if (!m) continue;
    const app = cleanAppName(m[1]);
    if (!app || toHttpsUrl(app)) continue;
    if (/^(a |an |the )?(command|terminal|shell|cmd)\b/i.test(app)) continue;
    if (app.length > 80) continue;
    // Never launch an app whose "name" still contains a compound connector.
    if (containsCommandConnector(app)) continue;
    return { action: "open_app", args: { app }, confidence: 0.88 };
  }
  return null;
}

function parseHinglishOpen(text) {
  const m = trimText(text).match(HINGLISH_OPEN_RE);
  if (!m) return null;
  const app = cleanAppName(m[1]);
  if (!app || toHttpsUrl(app) || app.length > 80) return null;
  if (containsCommandConnector(app)) return null;
  if (looksLikeChat(app)) return null;
  return { action: "open_app", args: { app }, confidence: 0.88 };
}

const HINGLISH_COMPOUND_RE = new RegExp(
  "^(.+?)\\s+(kholo|khol do|khol dena|chalao|chala do)\\s+(?:" +
    COMPOUND_CONNECTOR_RE.source +
    ")\\s+(.+)$",
  "i"
);

function planFromOpenAndClause(app, clause) {
  const name = cleanAppName(app);
  const typedIntent = intentFromTypedClause(clause);
  if (!name || !typedIntent || toHttpsUrl(name) || containsCommandConnector(name)) return null;
  if (name.length > 80) return null;
  return {
    action: "plan",
    args: {},
    steps: [
      { action: "open_app", args: { app: name } },
      typedIntent,
    ],
    confidence: 0.88,
  };
}


const BROWSER_NAME_RE = "(?:google\\s+)?chrome|firefox|edge|msedge|brave|safari|browser";
const SEARCH_WITH_BROWSER_RE = new RegExp(
  "^(?:open|launch|start|go to)\\s+(" + BROWSER_NAME_RE + ")\\s+(?:and\\s+)?(?:then\\s+)?(?:search|google|look up)\\s+(?:for\\s+)?(.+)$",
  "i"
);

function googleSearchUrl(query) {
  const q = String(query || "")
    .trim()
    .replace(/[.?!]+$/g, "")
    .trim();
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}

function parseOpenAndSearch(text) {
  const raw = trimText(text);
  const m = raw.match(SEARCH_WITH_BROWSER_RE);
  if (!m) return null;
  const app = cleanAppName(m[1]);
  const query = String(m[2] || "")
    .trim()
    .replace(/[.?!]+$/g, "")
    .trim();
  if (!app || !query || toHttpsUrl(app)) return null;
  return {
    action: "plan",
    args: {},
    steps: [
      { action: "open_app", args: { app } },
      { action: "open_url", args: { url: googleSearchUrl(query) } },
    ],
    confidence: 0.9,
  };
}

function parseCompoundOpenAndType(text) {
  const t = trimText(text);
  const split = t.match(COMPOUND_SPLIT_RE);
  if (split) {
    // Keep the type/write verb in the clause so "write a letter …" is compose
    // and "and in it type hello" still classifies as type_text.
    const verbClause = t.match(
      /(?:type|write|enter|paste|likho|likh do)\s+(?:this\s*)?[:\uFF1A]?\s*(.+)$/i
    );
    const plan = planFromOpenAndClause(split[1], verbClause ? verbClause[0] : split[2]);
    if (plan) return plan;
  }
  const hinglish = t.match(HINGLISH_COMPOUND_RE);
  if (hinglish) {
    return planFromOpenAndClause(hinglish[1], hinglish[3]);
  }
  return null;
}

function parseTypeText(text) {
  return intentFromTypedClause(text);
}

function parseRunCommand(text) {
  for (const re of RUN_PATTERNS) {
    const m = trimText(text).match(re);
    if (!m) continue;
    const command = stripWrappingQuotes(m[1]);
    if (!command) continue;
    // "run chrome" / "run notepad" is open_app, not a shell command
    if (/^(chrome|firefox|edge|notepad|calculator|spotify|code|vscode|word|excel)\s*$/i.test(command)) {
      return { action: "open_app", args: { app: command }, confidence: 0.86 };
    }
    return { action: "run_command", args: { command }, confidence: 0.86 };
  }
  return null;
}

function parseGuide(text) {
  const t = trimText(text);
  // "where is the capital of X" is chat, not a UI guide
  if (/\bcapital of\b/i.test(t) || /\bwhere is [a-z].*(born|located|from)\b/i.test(t)) return null;
  for (const re of GUIDE_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const target = stripWrappingQuotes(m[m.length - 1] || "")
      .replace(/^(the\s+)?/i, "")
      .replace(/\s+(button|icon|tab|link|menu|control)$/i, "")
      .trim();
    if (!target || target.length > 80) continue;
    return { action: "guide", args: { target }, confidence: 0.84 };
  }
  return null;
}

/**
 * Fast, offline parse. Returns a structured intent or `none`.
 * @param {string} text
 * @returns {{ action: string, args: Record<string, string>, confidence: number, source: string }}
 */
function parseIntentHeuristic(text) {
  const original = trimText(text);
  if (!original) {
    return { action: "none", args: {}, confidence: 1, source: "heuristic" };
  }
  const t = stripCommandWrappers(original) || original;
  // Compound open+write and type/compose must win over chat patterns such as
  // "write an email …", so "open notepad and write an email to …" stays a plan.
  const commandHit =
    parseOpenAndSearch(t) ||
    parseOpenAndSearch(original) ||
    parseCompoundOpenAndType(t) ||
    parseCompoundOpenAndType(original) ||
    parseTypeText(t) ||
    parseTypeText(original);
  if (commandHit) return { ...commandHit, source: "heuristic" };
  if (looksLikeChat(original) || looksLikeChat(t)) {
    return { action: "none", args: {}, confidence: 0.7, source: "heuristic" };
  }
  const hit =
    parseRunCommand(t) ||
    parseOpenUrl(t) ||
    parseGuide(t) ||
    parseOpenApp(t) ||
    parseHinglishOpen(t);
  if (hit) return { ...hit, source: "heuristic" };
  return { action: "none", args: {}, confidence: 0.35, source: "heuristic" };
}

function shouldUseLlm(heuristic) {
  if (!heuristic) return true;
  if (heuristic.action !== "none" && heuristic.confidence >= 0.7) return false;
  return heuristic.confidence < 0.7;
}

function buildIntentParsePrompt(text) {
  const allowed = COMMAND_ACTIONS.join(", ");
  return [
    "You convert one user request into a single desktop command for the Overlay app.",
    "Return ONLY a JSON object, no markdown, no commentary, with this shape:",
    `{"action":"${allowed.replace(/, /g, "|")}|none","app":"","url":"","command":"","text":"","prompt":"","target":"","confidence":0.0}`,
    "Rules:",
    `- action must be one of: ${allowed}, or none.`,
    "- none if this is a question, conversation, or anything that is not a desktop command. Asking to write a letter or email into an app is compose_text, not none.",
    "- open_url: only http(s) websites. Add https:// if the user named a site like youtube.com.",
    "- open_app: launch a program by name (Chrome, Notepad, VS Code, Settings, …). The app field must be only the app name, never 'and type …'.",
    "- run_command: only when the user clearly wants a shell/terminal command. Put the exact command in `command`.",
    "- type_text: type or paste the user's exact short words into the already-focused field. Put those words in `text`.",
    "- compose_text: the user wants a real letter, email, note, essay, message, or poem written. Put the writing request in `prompt`. Do not put the finished document in `text`.",
    "- guide: the user wants to find, be shown, or click a button/control on screen. Put the control name in `target`. Do not click it yourself.",
    "- Do not invent destructive commands (delete, format, shutdown, registry edits).",
    "- confidence is a number from 0 to 1.",
    "",
    "User request:",
    text,
  ].join("\n");
}

function extractJsonObject(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeParsedIntent(parsed, source) {
  if (!parsed || typeof parsed !== "object") {
    return { action: "none", args: {}, confidence: 0, source };
  }
  const action = COMMAND_ACTIONS.includes(parsed.action) ? parsed.action : "none";
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = action === "none" ? 0.5 : 0.7;
  confidence = Math.min(1, Math.max(0, confidence));
  const args = {};
  if (action === "open_app") args.app = trimText(parsed.app || parsed.name || parsed.target);
  if (action === "open_app" && containsCommandConnector(args.app)) {
    return { action: "none", args: {}, confidence: 0.2, source };
  }
  if (action === "open_url") {
    const url = toHttpsUrl(parsed.url || parsed.link || parsed.target || "");
    if (url) args.url = url;
    else return { action: "none", args: {}, confidence: 0.2, source };
  }
  if (action === "run_command") args.command = trimText(parsed.command || parsed.cmd || parsed.text);
  if (action === "type_text") args.text = String(parsed.text || parsed.content || "");
  if (action === "compose_text") args.prompt = trimText(parsed.prompt || parsed.text || parsed.content || "");
  if (action === "guide") args.target = trimText(parsed.target || parsed.app || parsed.text);
  if (action === "open_app" && !args.app) return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "run_command" && !args.command)
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "type_text" && !String(args.text || "").trim())
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "compose_text" && !args.prompt)
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "guide" && !args.target) return { action: "none", args: {}, confidence: 0.2, source };
  return { action, args, confidence, source };
}

function parseIntentFromLlmResponse(raw) {
  return normalizeParsedIntent(extractJsonObject(raw), "llm");
}

/**
 * Parse text, using the heuristic first and an optional LLM completer
 * (`async (prompt) => string`) when the guess is weak.
 */
async function parseIntent(text, { llmComplete, forceLlm = false } = {}) {
  const heuristic = parseIntentHeuristic(text);
  if (!forceLlm && !shouldUseLlm(heuristic)) return heuristic;
  if (typeof llmComplete !== "function") return heuristic;
  try {
    const raw = await llmComplete(buildIntentParsePrompt(text));
    const llm = parseIntentFromLlmResponse(raw);
    // Prefer a confident heuristic over a weak LLM "none".
    if (llm.action === "none" && heuristic.action !== "none" && heuristic.confidence >= 0.6) {
      return heuristic;
    }
    return llm;
  } catch (error) {
    const errorCode =
      error?.code === "TIMEOUT" || error?.name === "AbortError" ? "TIMEOUT" : "PARSE_ERROR";
    return {
      action: "none",
      args: {},
      confidence: 0,
      source: "llm",
      errorCode,
      errorMessage: String(error?.message || "parse failed"),
    };
  }
}

function formatIntentForConfirm(intent) {
  if (!intent || intent.action === "none") return "No desktop command";
  if (intent.action === "plan") {
    return (intent.steps || []).map((step) => formatIntentForConfirm(step)).join(", then ");
  }
  switch (intent.action) {
    case "open_app":
      return `Open app: ${intent.args.app}`;
    case "open_url":
      return `Open link: ${intent.args.url}`;
    case "run_command":
      return `Run command: ${intent.args.command}`;
    case "type_text": {
      const t = String(intent.args.text || "");
      const preview = t.length > 160 ? `${t.slice(0, 157)}...` : t;
      return `Type text: ${preview}`;
    }
    case "compose_text": {
      const t = String(intent.args.prompt || "");
      const preview = t.length > 160 ? `${t.slice(0, 157)}...` : t;
      return `Write: ${preview}`;
    }
    case "guide":
      return `Find on screen: ${intent.args.target}`;
    default:
      return String(intent.action);
  }
}

module.exports = {
  COMMAND_ACTIONS,
  parseIntentHeuristic,
  parseIntentFromLlmResponse,
  parseIntent,
  shouldUseLlm,
  buildIntentParsePrompt,
  extractJsonObject,
  formatIntentForConfirm,
  toHttpsUrl,
  looksLikeChat,
  looksImperative,
  stripCommandWrappers,
  containsCommandConnector,
  commandReferencesSelection,
  classifyTypedClause,
  intentFromTypedClause,
};

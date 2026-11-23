// Overlay Command mode: turn spoken or typed text into one structured intent.
// Pure functions — no Electron, no network. The LLM step is injected.

const { classifyTypedClause, intentFromTypedClause, commandReferencesSelection } = require("./typedClause");
const { commandSkillSystemPrompt } = require("./skillLoader");
const {
  parseBrowserSearch,
  utteranceWantsSearch,
  isSearchUrl,
  extractSearchQuery,
  namedBrowserInUtterance,
  googleSearchUrl,
  resolveBrowserAlias,
} = require("./browserSearch");
const { parseCalendarEvent, parseWebAppOpen, parseGmailCompose } = require("./webApps");
const { parseAppSkillIntent, buildDynamicIntentContext } = require("./appSkillMatcher");
const { parseFindPath } = require("./findPath");
const { isMetaIntent } = require("./metaIntent");

const COMMAND_ACTIONS = [
  "open_app",
  "open_url",
  "run_command",
  "type_text",
  "compose_text",
  "compose_email",
  "guide",
  "app_action",
  "mcp",
  "find_path",
  "open_path",
];

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
  /^(?:(?:please|pls|plz|zara|yaar|bhai|kripaya|kripya|krupa|hey overlay|ok overlay|okay overlay|overlay,|overlay\s*[,:]?|can you|could you|would you|will you|can u|could u|would u)\s+)+/i;
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
  const typedIntent = intentFromTypedClause(clause, { afterOpen: true });
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
function parseIntentHeuristic(text, options = {}) {
  const original = trimText(text);
  if (!original) {
    return { action: "none", args: {}, confidence: 1, source: "heuristic" };
  }
  const t = stripCommandWrappers(original) || original;
  // Compound open+write and type/compose must win over chat patterns such as
  // "write an email …", so "open notepad and write an email to …" stays a plan.
  if (isMetaIntent(original) || isMetaIntent(t)) {
    return { action: "none", args: {}, confidence: 1, source: "heuristic", metaIntent: true };
  }
  const commandHit =
    parseCalendarEvent(t, options) ||
    parseCalendarEvent(original, options) ||
    parseFindPath(t) ||
    parseFindPath(original) ||
    parseBrowserSearch(t) ||
    parseBrowserSearch(original) ||
    parseWebAppOpen(t) ||
    parseWebAppOpen(original) ||
    parseGmailCompose(t) ||
    parseGmailCompose(original) ||
    parseCompoundOpenAndType(t) ||
    parseCompoundOpenAndType(original) ||
    parseTypeText(t) ||
    parseTypeText(original) ||
    parseAppSkillIntent(t, options) ||
    parseAppSkillIntent(original, options);
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

function buildIntentUserMessage(text, options = {}) {
  const base = "User request:\n" + String(text || "").trim();
  const extra = buildDynamicIntentContext({
    skills: options.skills,
    learned: options.learned,
    text,
  });
  return extra ? base + "\n\n" + extra : base;
}

function buildIntentParseMessages(text, options = {}) {
  return { system: commandSkillSystemPrompt(), user: buildIntentUserMessage(text, options) };
}

function buildIntentParsePrompt(text, options = {}) {
  const messages = buildIntentParseMessages(text, options);
  return messages.system + "\n\n" + messages.user;
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

function clampConfidence(value, fallback) {
  let confidence = Number(value);
  if (!Number.isFinite(confidence)) confidence = fallback;
  return Math.min(1, Math.max(0, confidence));
}

function normalizeSingleIntent(parsed, source) {
  const action = COMMAND_ACTIONS.includes(parsed.action) ? parsed.action : "none";
  const confidence = clampConfidence(parsed.confidence, action === "none" ? 0.5 : 0.7);
  const args = {};
  if (action === "open_app") args.app = trimText(parsed.app || parsed.name || parsed.target);
  if (action === "open_app" && containsCommandConnector(args.app)) {
    return { action: "none", args: {}, confidence: 0.2, source };
  }
  if (action === "open_url") {
    const url = toHttpsUrl(parsed.url || parsed.link || parsed.target || "");
    if (url) args.url = url;
    else return { action: "none", args: {}, confidence: 0.2, source };
    const browser = trimText(parsed.browser || (!toHttpsUrl(parsed.app || "") ? parsed.app : "") || "");
    if (browser) {
      const product = resolveBrowserAlias(browser);
      args.browser = product === "default" ? "browser" : product || browser;
    }
  }
  if (action === "run_command") args.command = trimText(parsed.command || parsed.cmd || parsed.text);
  if (action === "type_text") args.text = String(parsed.text || parsed.content || "");
  if (action === "compose_text") args.prompt = trimText(parsed.prompt || parsed.text || parsed.content || "");
  if (action === "compose_email") {
    args.to = trimText(parsed.to || parsed.email || "");
    args.subject = trimText(parsed.subject || parsed.su || "");
    args.prompt = trimText(parsed.prompt || parsed.text || parsed.content || "");
    if (!args.prompt && (args.to || args.subject)) {
      args.prompt = `Write an email${args.to ? " to " + args.to : ""}${
        args.subject ? " about " + args.subject : ""
      }. Output only the email body as plain text, with no subject line and no preamble.`;
    }
  }
  if (action === "guide") args.target = trimText(parsed.target || parsed.app || parsed.text);
  if (action === "app_action") {
    args.appId = trimText(parsed.appId || parsed.app || "");
    args.actionId = trimText(parsed.actionId || parsed.action_id || "");
    const params = parsed.params || parsed.args && parsed.args.params;
    args.params = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  }
  if (action === "open_app" && !args.app) return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "run_command" && !args.command)
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "type_text" && !String(args.text || "").trim())
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "compose_text" && !args.prompt)
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "compose_email" && !args.to && !args.prompt)
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "guide" && !args.target) return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "app_action" && (!args.appId || !args.actionId))
    return { action: "none", args: {}, confidence: 0.2, source };
  if (action === "find_path") {
    args.name = trimText(parsed.name || parsed.query || parsed.text || args.name || "");
    args.kind = trimText(parsed.kind || args.kind || "any") || "any";
    if (parsed.within || args.within) args.within = trimText(parsed.within || args.within);
    if (!args.name) return { action: "none", args: {}, confidence: 0.2, source };
  }
  if (action === "open_path") {
    args.path = trimText(parsed.path || parsed.target || args.path || "");
    if (parsed.searchQuery || args.searchQuery) args.searchQuery = trimText(parsed.searchQuery || args.searchQuery);
    if (parsed.searchMs || args.searchMs) args.searchMs = true;
    if (parsed.location || args.location) args.location = trimText(parsed.location || args.location);
    if (parsed.run || args.run) args.run = true;
    if (!args.path && !args.searchMs) return { action: "none", args: {}, confidence: 0.2, source };
  }
  return { action, args, confidence, source };
}

function normalizeParsedIntent(parsed, source) {
  if (!parsed || typeof parsed !== "object") {
    return { action: "none", args: {}, confidence: 0, source };
  }
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : null;
  if (parsed.action === "plan" || (rawSteps && rawSteps.length && parsed.action !== "open_url")) {
    const steps = rawSteps
      ? rawSteps
          .map((step) => normalizeSingleIntent({ ...step, confidence: step?.confidence ?? 1 }, source))
          .filter((step) => step.action !== "none")
      : [];
    if (!steps.length) return { action: "none", args: {}, confidence: 0.2, source };
    if (steps.length === 1) {
      return { ...steps[0], confidence: clampConfidence(parsed.confidence, steps[0].confidence), source };
    }
    return {
      action: "plan",
      args: {},
      steps,
      confidence: clampConfidence(parsed.confidence, 0.8),
      source,
    };
  }
  return normalizeSingleIntent(parsed, source);
}

function intentStepsOf(intent) {
  if (!intent || intent.action === "none") return [];
  if (intent.action === "plan" && Array.isArray(intent.steps)) return intent.steps;
  return [intent];
}

function hasSearchStep(intent) {
  return intentStepsOf(intent).some((step) => step.action === "open_url" && isSearchUrl(step.args?.url));
}

function expectedStepCount(text) {
  const t = stripCommandWrappers(text) || trimText(text);
  const search = utteranceWantsSearch(t);
  const browserOrTube = Boolean(namedBrowserInUtterance(t) || /\byoutube\b|\byt\b/i.test(t));
  const open = /\b(open|launch|start|go to|goto|visit|kholo|chalao)\b/i.test(t);
  const typeOrCompose = /\b(type|write|enter|paste|likho)\b/i.test(t);
  const run = /\b(run|execute)\b/i.test(t);
  let n = 0;
  if (search && (browserOrTube || open)) n += 1;
  else {
    if (open) n += 1;
    if (search) n += 1;
  }
  if (typeOrCompose) n += 1;
  if (run) n += 1;
  return n;
}

function sanitizeSearchUrl(url, utterance) {
  try {
    const parsed = new URL(url);
    const key = /youtube\.com$/i.test(parsed.hostname) ? "search_query" : "q";
    const raw = parsed.searchParams.get(key) || "";
    const dirty = /[{}']|confidence\s*:/i.test(raw);
    if (!dirty) return url;
    const fallback = extractSearchQuery(utterance) || raw.split(/['"{,]/)[0].trim();
    if (!fallback) return url;
    parsed.searchParams.set(key, fallback);
    return parsed.toString();
  } catch {
    return url;
  }
}

function cleanIntentSearchUrls(text, intent) {
  if (!intent) return intent;
  const steps = intentStepsOf(intent);
  let changed = false;
  for (const step of steps) {
    if (step.action === "open_url" && isSearchUrl(step.args?.url)) {
      const cleaned = sanitizeSearchUrl(step.args.url, text);
      if (cleaned !== step.args.url) {
        step.args.url = cleaned;
        changed = true;
      }
    }
  }
  if (changed) intent.repaired = true;
  return intent;
}

function planAlreadyHasNonBrowserWork(intent) {
  return intentStepsOf(intent).some((step) => {
    if (!step || !step.action || step.action === "none") return false;
    if (step.action === "open_url" && isSearchUrl(step.args?.url)) return false;
    // Opening a browser is not the work — a missing search may still be needed.
    if (step.action === "open_app") {
      const product =
        resolveBrowserAlias(step.args?.app || "") || namedBrowserInUtterance(step.args?.app || "");
      if (product) return false;
    }
    return true;
  });
}

function repairMissingSearch(text, intent) {
  if (isMetaIntent(text)) return intent;
  if (!utteranceWantsSearch(text) || hasSearchStep(intent)) return intent;
  // Never bolt a fallback Google search onto a calendar, email, or app plan.
  if (planAlreadyHasNonBrowserWork(intent)) return intent;
  // Only a real browser-search parse may invent a search. Never extract a
  // query from a complaint or other utterance that merely contains "search".
  const parsed = parseBrowserSearch(text);
  if (!parsed) return intent;
  const steps = intentStepsOf(intent);
  const browser = parsed.args.browser;
  const matchesBrowserOpen = (step) => {
    if (step.action !== "open_app") return false;
    const product = resolveBrowserAlias(step.args?.app || "") || namedBrowserInUtterance(step.args?.app || "");
    if (!browser) return Boolean(product);
    const wanted = resolveBrowserAlias(browser) || browser;
    return product === wanted || (wanted === "default" && product);
  };
  const onlyBrowserOpen = steps.length === 1 && matchesBrowserOpen(steps[0]);
  if (onlyBrowserOpen || intent.action === "none" || steps.length === 0) {
    return { ...parsed, source: intent.source || "heuristic", repaired: true };
  }
  const next = steps.slice();
  const idx = next.findIndex(matchesBrowserOpen);
  const searchStep = { action: "open_url", args: parsed.args };
  if (idx >= 0) next.splice(idx, 1, searchStep);
  else next.push(searchStep);
  if (next.length === 1) {
    return { ...next[0], confidence: Math.max(intent.confidence || 0, 0.85), source: intent.source, repaired: true };
  }
  return {
    action: "plan",
    args: {},
    steps: next,
    confidence: Math.max(intent.confidence || 0, 0.85),
    source: intent.source,
    repaired: true,
  };
}

async function applyClausePostCheck(text, intent, { llmComplete, alreadyReasked = false, skills, learned } = {}) {
  let current = cleanIntentSearchUrls(text, repairMissingSearch(text, intent));
  const expected = expectedStepCount(text);
  const actual = intentStepsOf(current).length;
  if (expected <= actual || alreadyReasked || typeof llmComplete !== "function") return current;
  try {
    const raw = await llmComplete({
      system: commandSkillSystemPrompt(),
      user:
        "The previous plan dropped one or more clauses. Output a complete JSON plan that covers every clause. Do not drop search, type, or compose clauses.\n\n" +
        buildIntentUserMessage(text, { skills, learned }),
    });
    const retry = parseIntentFromLlmResponse(raw);
    const repaired = repairMissingSearch(text, retry);
    if (intentStepsOf(repaired).length >= actual) {
      return { ...repaired, source: "llm", reasked: true };
    }
  } catch {
    // Keep the best intent we already have.
  }
  return current;
}

function parseIntentFromLlmResponse(raw) {
  return normalizeParsedIntent(extractJsonObject(raw), "llm");
}

/**
 * Parse text, using the heuristic first and an optional LLM completer
 * (`async (prompt) => string`) when the guess is weak.
 */
async function parseIntent(text, { llmComplete, forceLlm = false, skills, learned } = {}) {
  const heuristic = parseIntentHeuristic(text, { skills, learned });
  if (!forceLlm && !shouldUseLlm(heuristic)) {
    return applyClausePostCheck(text, heuristic, { alreadyReasked: true, skills, learned });
  }
  if (typeof llmComplete !== "function") {
    return applyClausePostCheck(text, heuristic, { alreadyReasked: true, skills, learned });
  }
  try {
    const raw = await llmComplete(buildIntentParseMessages(text, { skills, learned }));
    const llm = parseIntentFromLlmResponse(raw);
    // Prefer a confident heuristic over a weak LLM "none".
    if (llm.action === "none" && heuristic.action !== "none" && heuristic.confidence >= 0.6) {
      return applyClausePostCheck(text, heuristic, { llmComplete, alreadyReasked: true, skills, learned });
    }
    return applyClausePostCheck(text, llm, { llmComplete, alreadyReasked: false, skills, learned });
  } catch (error) {
    const errorCode =
      error?.code === "TIMEOUT" || error?.name === "AbortError" ? "TIMEOUT" : "PARSE_ERROR";
    const failed = {
      action: "none",
      args: {},
      confidence: 0,
      source: "llm",
      errorCode,
      errorMessage: String(error?.message || "parse failed"),
    };
    if (heuristic.action !== "none" && heuristic.confidence >= 0.6) return heuristic;
    return applyClausePostCheck(text, failed, { alreadyReasked: true, skills, learned });
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
      return intent.args?.browser
        ? `Open link in ${intent.args.browser}: ${intent.args.url}`
        : `Open link: ${intent.args.url}`;
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
    case "compose_email":
      return `Draft Gmail to ${intent.args?.to || "recipient"}: ${intent.args?.subject || intent.args?.prompt || ""}`;
    case "guide":
      return `Find on screen: ${intent.args.target}`;
    case "app_action":
      return `Run ${intent.args?.actionId || "action"} in ${intent.args?.appId || "app"}`;
    case "mcp":
      return `Call tool "${intent.args?.tool || intent.tool}" on ${intent.args?.server || intent.server || "MCP server"}`;
    default:
      return String(intent.action);
  }
}

module.exports = {
  COMMAND_ACTIONS,
  parseFindPath,
  parseIntentHeuristic,
  parseIntentFromLlmResponse,
  parseIntent,
  shouldUseLlm,
  buildIntentParsePrompt,
  buildIntentParseMessages,
  buildIntentUserMessage,
  extractJsonObject,
  formatIntentForConfirm,
  repairMissingSearch,
  cleanIntentSearchUrls,
  expectedStepCount,
  intentStepsOf,
  toHttpsUrl,
  looksLikeChat,
  parseCalendarEvent,
  parseWebAppOpen,
  parseGmailCompose,
  parseAppSkillIntent,
  looksImperative,
  stripCommandWrappers,
  containsCommandConnector,
  commandReferencesSelection,
  classifyTypedClause,
  intentFromTypedClause,
};

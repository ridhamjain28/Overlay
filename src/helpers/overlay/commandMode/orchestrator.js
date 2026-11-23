// One planner, one executor. Chat and voice both call orchestrate() once.
// A plan is an ordered list of typed steps; the executor runs exactly those
// steps, verifies each one, and never invents a web search of the raw
// utterance unless the plan already contains a search step.

const { URL } = require("url");
const { isMetaIntent, formatMetaExplanation } = require("./metaIntent");
const { formatFindOutcome, isExecutablePath } = require("./findPath");

const DEDUPE_MS = 2500;
const DEFAULT_SUBMIT_TIMEOUT_MS = 12000;
const NEVER_AUTOSUBMIT_APP_IDS = new Set([
  "gmail",
  "google-gmail",
  "whatsapp",
  "teams",
  "microsoft-teams",
  "outlook",
  "mail",
  "slack",
  "telegram",
  "discord",
  "messages",
]);

function normalizeKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cloneSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((step) => ({
    action: String(step?.action || "").trim(),
    type: step?.type,
    server: step?.server,
    tool: step?.tool,
    args: { ...(step?.args || {}) },
    source: step?.source,
    postcheck: step?.postcheck,
    annotations: step?.annotations,
    inputSchema: step?.inputSchema,
  }));
}

function intentSteps(intent) {
  if (!intent) return [];
  if (Array.isArray(intent.steps) && intent.steps.length) return cloneSteps(intent.steps);
  if (intent.action && intent.action !== "none") {
    return [
      {
        action: intent.action,
        type: intent.type,
        server: intent.server,
        tool: intent.tool,
        args: { ...(intent.args || {}) },
        source: intent.source,
        annotations: intent.annotations,
        inputSchema: intent.inputSchema,
      },
    ];
  }
  return [];
}

function stepUrl(step) {
  const raw =
    (step && step.args && (step.args.url || step.args.uri || step.args.value)) ||
    (typeof step === "string" ? step : "");
  return String(raw || "").trim();
}

function isSearchUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "google.com" && parsed.pathname.startsWith("/search")) return true;
    if (host === "bing.com" && parsed.pathname.startsWith("/search")) return true;
    if (host === "duckduckgo.com" && parsed.searchParams.has("q")) return true;
    return false;
  } catch {
    return /google\.[^/]+\/search\?/i.test(url);
  }
}

function searchQueryOf(url) {
  try {
    return new URL(url).searchParams.get("q") || "";
  } catch {
    const match = String(url || "").match(/[?&]q=([^&]+)/);
    return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : "";
  }
}

function isCalendarPrefillUrl(url) {
  const value = String(url || "");
  if (!/calendar\.google\.com/i.test(value)) return false;
  return /eventedit|action=TEMPLATE|calendar\/u\/\d+\/r\/eventedit/i.test(value);
}

function isCalendarPrefillStep(step) {
  if (!step) return false;
  const url = stepUrl(step);
  if (isCalendarPrefillUrl(url)) return true;
  if (step.action === "app_action") {
    const appId = String(step.args?.appId || "").toLowerCase();
    const actionId = String(step.args?.actionId || "").toLowerCase();
    if (appId.includes("calendar") && /create|add|event/i.test(actionId)) return true;
  }
  return false;
}

function isMessagingStep(step) {
  if (!step) return false;
  const appId = String(step.args?.appId || step.args?.app || "").toLowerCase();
  if (NEVER_AUTOSUBMIT_APP_IDS.has(appId)) return true;
  const url = stepUrl(step);
  if (/mail\.google\.com|wa\.me|web\.whatsapp|teams\.microsoft|outlook\.live|outlook\.office/i.test(url)) {
    return true;
  }
  return false;
}

function isRawUtteranceSearch(url, text) {
  if (!isSearchUrl(url)) return false;
  const query = searchQueryOf(url);
  const nq = normalizeKey(query);
  const nt = normalizeKey(text);
  if (!nq || !nt) return false;
  if (nq === nt) return true;
  const words = nq.split(" ").filter(Boolean);
  if (words.length >= 6 && (nt.includes(nq) || nq.includes(nt))) return true;
  return false;
}

function looksLikeCreateOrSave(text) {
  return /\b(add|create|save|schedule|book|make|set up|setup|put)\b/i.test(String(text || ""));
}

/**
 * Drop a search of the raw utterance when the plan already does real work,
 * or when the only "search" is the command text itself.
 */
function parsePickNumber(text, last) {
  const m = String(text || "").trim().match(/^(?:open\s+)?(?:number\s+|option\s+|#)?([1-5])(?:st|nd|rd|th)?$/i);
  if (!m) return null;
  const find = (last?.results || []).find((row) => row && row.action === "find_path" && Array.isArray(row.matches));
  if (!find || !find.matches.length) return null;
  return find.matches[Number(m[1]) - 1] || null;
}

function isExplorerStep(step) {
  if (!step) return false;
  if (step.action === "open_path") return true;
  const app = String(step.args?.app || step.args?.appId || "");
  return /explorer|^files$/i.test(app);
}

function sanitizePlan(text, steps) {
  if (isMetaIntent(text)) return [];
  const list = cloneSteps(steps);
  const hasWork = list.some((step) => {
    if (!step.action || step.action === "none") return false;
    if (step.action === "open_url" && isRawUtteranceSearch(stepUrl(step), text)) return false;
    return true;
  });
  return list.filter((step) => {
    if (!step.action || step.action === "none") return false;
    if (step.action === "open_url" && isRawUtteranceSearch(stepUrl(step), text) && hasWork) {
      return false;
    }
    if (step.action === "open_url" && isRawUtteranceSearch(stepUrl(step), text) && !hasWork) {
      // A lone search of the raw command is not a real search intent.
      if (looksLikeCreateOrSave(text) || /\b(calendar|event|meeting|appointment)\b/i.test(text)) {
        return false;
      }
    }
    return true;
  });
}

function submitSpecForStep(step, { autoSaveCreatedItems = true } = {}) {
  if (!autoSaveCreatedItems) return null;
  if (isMessagingStep(step)) return null;
  const auto = step.args?.autoSubmit ?? step.autoSubmit;
  const wantsAuto =
    auto === true ||
    (auto && typeof auto === "object" && auto.enabled !== false) ||
    (auto == null && isCalendarPrefillStep(step));
  if (!wantsAuto) return null;
  const fromDb = auto && typeof auto === "object" ? auto : {};
  return {
    matchTitle: fromDb.matchTitle || "Calendar",
    matchUrl: fromDb.matchUrl || "eventedit",
    keys: fromDb.keys || "control+s",
    leaveUrl: fromDb.leaveUrl || "eventedit",
    timeoutMs: Number(fromDb.timeoutMs) || DEFAULT_SUBMIT_TIMEOUT_MS,
  };
}

function attachFinishSteps(text, steps, options = {}) {
  const { autoSaveCreatedItems = true } = options;
  if (!looksLikeCreateOrSave(text) && !steps.some(isCalendarPrefillStep)) return cloneSteps(steps);
  const out = [];
  for (const step of cloneSteps(steps)) {
    out.push(step);
    const spec = submitSpecForStep(step, { autoSaveCreatedItems });
    if (!spec) continue;
    out.push({
      action: "submit_page",
      args: { ...spec, sourceUrl: stepUrl(step) },
      source: "autoSubmit",
    });
  }
  return out;
}

function compactStampParts(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!match) return null;
  return {
    year: match[1],
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function formatClock(hour, minute) {
  const mer = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  if (!minute) return `${h} ${mer}`;
  return `${h}:${String(minute).padStart(2, "0")} ${mer}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function capFirst(value) {
  const title = String(value || "event").trim() || "event";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function formatCalendarOutcome(steps, success, saved) {
  const step = (steps || []).find(isCalendarPrefillStep);
  if (!step) return null;
  const url = stepUrl(step);
  let title = step.args?.params?.title || step.args?.title || "";
  let start = step.args?.params?.start || step.args?.start;
  let end = step.args?.params?.end || step.args?.end;
  try {
    const parsed = new URL(url);
    title = title || parsed.searchParams.get("text") || "event";
    const dates = parsed.searchParams.get("dates") || "";
    const [s, e] = dates.split("/");
    start = start || s;
    end = end || e;
  } catch {
    // Ignore unparsable template URLs.
  }
  const from = compactStampParts(start);
  const to = compactStampParts(end);
  const when = from
    ? `${MONTHS[from.month - 1]} ${from.day}${
        to ? `, ${formatClock(from.hour, from.minute).replace(" PM", "").replace(" AM", "")}–${formatClock(to.hour, to.minute)}`.replace("–", "–") : ""
      }`
    : "";
  const prettyTitle = capFirst(title);
  // Prefer the requested "Nov 24, 5-7 PM" style when both stamps exist.
  let whenPretty = when;
  if (from && to) {
    const startClock = formatClock(from.hour, from.minute);
    const endClock = formatClock(to.hour, to.minute);
    const startBit = startClock.replace(/ (AM|PM)$/, "");
    const mer = endClock.endsWith("PM") ? "PM" : "AM";
    whenPretty = `${MONTHS[from.month - 1]} ${from.day}, ${startBit}-${endClock.replace(/ (AM|PM)$/, "")} ${mer}`;
  }
  if (!success) return `Could not add ${prettyTitle} to your calendar${whenPretty ? ` for ${whenPretty}` : ""}.`;
  if (saved === false) {
    return `Opened ${prettyTitle} in your calendar${whenPretty ? ` for ${whenPretty}` : ""}, but it was not saved.`;
  }
  return `Added ${prettyTitle} to your calendar${whenPretty ? ` for ${whenPretty}` : ""}.`;
}

function formatSearchOutcome(step) {
  const url = stepUrl(step);
  const query = searchQueryOf(url) || "the web";
  const browser = step.args?.browser;
  return browser
    ? `Opened a search for ${query} in ${browser}.`
    : `Opened a search for ${query}.`;
}

function validateSchemaArgs(args = {}, schema = {}) {
  if (!schema || typeof schema !== "object") return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === "") {
      return `Missing required parameter "${field}"`;
    }
  }
  const properties = schema.properties || {};
  for (const [key, val] of Object.entries(args)) {
    const propSpec = properties[key];
    if (!propSpec || !propSpec.type) continue;
    const expectedType = propSpec.type;
    const actualType = typeof val;
    if (expectedType === "string" && actualType !== "string") {
      return `Parameter "${key}" must be a string`;
    }
    if (expectedType === "number" && actualType !== "number") {
      return `Parameter "${key}" must be a number`;
    }
    if (expectedType === "boolean" && actualType !== "boolean") {
      return `Parameter "${key}" must be a boolean`;
    }
    if (expectedType === "array" && !Array.isArray(val)) {
      return `Parameter "${key}" must be an array`;
    }
    if (expectedType === "object" && (actualType !== "object" || Array.isArray(val) || val === null)) {
      return `Parameter "${key}" must be an object`;
    }
  }
  return null;
}

function formatOutcome(text, steps, results) {
  const ok = !results.some((row) => row && row.success === false);
  const mcpRow = results.find((row) => row && (row.action === "mcp" || row.type === "mcp") && row.message);
  if (mcpRow) return mcpRow.rawMessage || mcpRow.message;
  const calendar = formatCalendarOutcome(steps, ok, results.some((row) => row && row.action === "submit_page")
    ? results.find((row) => row.action === "submit_page")?.success
    : undefined);
  if (calendar) return calendar;
  const first = steps[0];
  if (!first) return ok ? "Done." : "The command failed.";
  if (first.action === "open_url" && isSearchUrl(stepUrl(first))) return formatSearchOutcome(first);
  if (first.action === "open_app") {
    const app = first.args?.app || "the app";
    const typed = steps.some((step) => step.action === "type" || step.action === "compose_text");
    if (typed) return `Opened ${app} and started writing.`;
    return `Opened ${app}.`;
  }
  const findResult = results.find((row) => row && row.action === "find_path");
  if (findResult) {
    return findResult.message || formatFindOutcome(findResult);
  }
  if (first.action === "open_path") {
    return results[results.length - 1]?.message || (ok ? `Opened ${first.args?.path || "the path"}.` : "The path could not be opened.");
  }
  if (first.action === "app_action") {
    return ok ? `Ran ${first.args?.actionId || "the action"} in ${first.args?.appId || "the app"}.` : "The action failed.";
  }
  if (!ok) {
    const failed = results.find((row) => row && row.success === false);
    return failed?.message || failed?.error || "The command failed.";
  }
  return results[results.length - 1]?.message || "Done.";
}

function windowMatches(win, spec) {
  if (!win) return false;
  const title = String(win.title || win.windowTitle || "");
  const url = String(win.url || "");
  if (spec.matchUrl && url && url.toLowerCase().includes(String(spec.matchUrl).toLowerCase())) return true;
  if (spec.matchTitle && title.toLowerCase().includes(String(spec.matchTitle).toLowerCase())) return true;
  if (spec.leaveUrl && url && !url.toLowerCase().includes(String(spec.leaveUrl).toLowerCase())) return true;
  return false;
}

function createOrchestrator(deps = {}) {
  const recent = new Map();
  const inFlight = new Set();
  const parseIntent = deps.parseIntent;
  const perform = deps.perform;
  const listWindows = deps.listWindows;
  const focusWindow = deps.focusWindow;
  const sendKeys = deps.sendKeys;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());

  function remember(key) {
    recent.set(key, now());
    for (const [item, at] of recent) {
      if (now() - at > DEDUPE_MS * 4) recent.delete(item);
    }
  }

  function wasRecent(key) {
    const at = recent.get(key);
    return at != null && now() - at < DEDUPE_MS;
  }

  async function readWindows() {
    if (typeof listWindows !== "function") return { unsupported: true, windows: [] };
    const listed = await listWindows();
    if (listed && listed.unsupported) return { unsupported: true, windows: [] };
    return { unsupported: false, windows: Array.isArray(listed) ? listed : [] };
  }

  async function waitForWindow(spec, timeoutMs) {
    const first = await readWindows();
    if (first.unsupported) return { ok: true, skipped: true };
    const deadline = now() + timeoutMs;
    let windows = first.windows;
    while (true) {
      const hit = windows.find((win) => windowMatches(win, spec));
      if (hit) return { ok: true, window: hit };
      if (now() > deadline) return { ok: false, error: "Timed out waiting for the page to open." };
      await sleep(200);
      windows = (await readWindows()).windows;
    }
  }

  async function verifyStep(step, result) {
    if (result?.success === false) {
      return { ok: false, message: result.message || result.error || "The step failed." };
    }
    if (step.postcheck && typeof deps.postcheck === "function") {
      const checked = await deps.postcheck(step, result);
      if (checked && checked.ok === false) return { ok: false, message: checked.message || "Verification failed." };
    }
    if (isExplorerStep(step) && typeof listWindows === "function") {
      const title = step.args?.path
        ? String(step.args.path).split(/[\\/]/).filter(Boolean).pop()
        : "File Explorer";
      const waited = await waitForWindow({ matchTitle: title }, 4000);
      if (!waited.ok && !waited.skipped) {
        const fallback = await waitForWindow({ matchTitle: "File Explorer" }, 1500);
        if (!fallback.ok && !fallback.skipped) return { ok: true, soft: true };
      }
    }
    if (step.action === "open_url" && isCalendarPrefillStep(step) && typeof listWindows === "function") {
      const waited = await waitForWindow(
        { matchTitle: "Calendar", matchUrl: "eventedit" },
        8000
      );
      if (!waited.ok && !waited.skipped) {
        // Best-effort: the template may still have opened in a tab whose title is lagging.
        return { ok: true, soft: true };
      }
    }
    return { ok: true };
  }

  async function executeSubmitPage(step) {
    const spec = step.args || {};
    const timeoutMs = Number(spec.timeoutMs) || DEFAULT_SUBMIT_TIMEOUT_MS;
    const waited = await waitForWindow(
      { matchTitle: spec.matchTitle, matchUrl: spec.matchUrl || "eventedit" },
      timeoutMs
    );
    if (!waited.ok && !waited.skipped) {
      return { success: false, action: "submit_page", message: "Opened the event but could not find the Calendar editor." };
    }
    if (waited.window && typeof focusWindow === "function") {
      await focusWindow(waited.window);
    }
    if (typeof sendKeys !== "function") {
      return { success: false, action: "submit_page", message: "Opened the event but could not send the save shortcut." };
    }
    try {
      await sendKeys(spec.keys || "control+s");
    } catch (error) {
      return {
        success: false,
        action: "submit_page",
        message: "Opened the event but could not send the save shortcut.",
      };
    }
    const listed = await readWindows();
    if (!listed.unsupported) {
      const deadline = now() + Math.min(timeoutMs, 6000);
      while (now() <= deadline) {
        const windows = (await readWindows()).windows;
        const stillEditing = windows.some((win) => {
          const url = String(win.url || "");
          return url && url.toLowerCase().includes(String(spec.leaveUrl || "eventedit").toLowerCase());
        });
        const calendarOpen = windows.some((win) => windowMatches(win, { matchTitle: spec.matchTitle || "Calendar" }));
        if (!stillEditing && (calendarOpen || !windows.some((win) => win.url))) {
          return { success: true, action: "submit_page", message: "Saved." };
        }
        await sleep(200);
      }
      // Titles alone (no URL) cannot prove we left /eventedit; treat key-send as success.
      if (!waited.window?.url) return { success: true, action: "submit_page", message: "Saved." };
      return { success: false, action: "submit_page", message: "Opened the event but it did not leave the editor after save." };
    }
    return { success: true, action: "submit_page", message: "Saved." };
  }

  let lastOutcome = null;

  async function executeMcpStep(step, callOptions = {}) {
    const riskPolicy = deps.riskPolicy || require("./riskPolicy");
    const risk = riskPolicy.classify(step, { askBeforeEveryAction: callOptions.askBeforeEveryAction });
    if (risk === "block") {
      return { success: false, action: "mcp", error: "That MCP action is blocked for security", code: "BLOCKED" };
    }
    if (risk === "confirm" && !callOptions.confirmed) {
      const detail = riskPolicy.formatRiskConfirmDetail(step);
      const allowed = typeof deps.confirm === "function" ? await deps.confirm(detail, { step }) : false;
      if (!allowed) {
        return { success: false, action: "mcp", error: "You cancelled this command", code: "CANCELLED" };
      }
    }
    const schema =
      step.inputSchema ||
      (typeof deps.getToolSchema === "function" ? deps.getToolSchema(step.server, step.tool) : null);
    if (schema && typeof schema === "object") {
      const valError = validateSchemaArgs(step.args || {}, schema);
      if (valError) {
        return { success: false, action: "mcp", error: valError, code: "INVALID_ARGS" };
      }
    }

    if (typeof deps.callMcpTool !== "function") {
      return { success: false, action: "mcp", error: "No MCP tool executor is available", code: "UNAVAILABLE" };
    }

    try {
      const toolRes = await deps.callMcpTool(step.server, step.tool, step.args || {});
      let summaryText = "";
      if (toolRes && Array.isArray(toolRes.content)) {
        summaryText = toolRes.content
          .filter((c) => c && c.type === "text")
          .map((c) => c.text)
          .join("\n");
      } else if (typeof toolRes === "string") {
        summaryText = toolRes;
      } else if (toolRes && typeof toolRes === "object") {
        summaryText = toolRes.text || JSON.stringify(toolRes);
      }
      let rawSummary = summaryText || `Called ${step.tool} on ${step.server}`;
      const MAX_MCP_RESULT_LENGTH = 16384;
      if (rawSummary.length > MAX_MCP_RESULT_LENGTH) {
        rawSummary = rawSummary.slice(0, MAX_MCP_RESULT_LENGTH) + "\n...[TRUNCATED]";
      }
      const wrappedMessage = `=== UNTRUSTED MCP TOOL RESULT (${step.server}.${step.tool}) ===\n${rawSummary}\n=== END UNTRUSTED MCP TOOL RESULT ===`;
      return {
        success: !toolRes?.isError,
        action: "mcp",
        server: step.server,
        tool: step.tool,
        message: wrappedMessage,
        rawMessage: rawSummary,
        content: toolRes?.content,
      };
    } catch (err) {
      return { success: false, action: "mcp", error: err?.message || "MCP call failed", code: "MCP_ERROR" };
    }
  }

  async function plan(text, options = {}) {
    if (isMetaIntent(text)) {
      return { steps: [], intent: { action: "none", metaIntent: true }, source: "meta", metaIntent: true };
    }
    if (typeof parseIntent !== "function") {
      return { steps: [], intent: null, source: "none" };
    }
    const intent = await parseIntent(text, options);
    if (intent?.metaIntent || isMetaIntent(text)) {
      return { steps: [], intent, source: "meta", metaIntent: true };
    }
    const rawSteps = intentSteps(intent);
    const cleaned = sanitizePlan(text, rawSteps);
    const autoSaveCreatedItems = options.autoSaveCreatedItems !== false;
    const steps = attachFinishSteps(text, cleaned, { autoSaveCreatedItems });
    return { steps, intent, source: intent?.source || "none" };
  }

  function storeLast(outcome) {
    lastOutcome = outcome;
    return outcome;
  }

  async function orchestrate(text, options = {}) {
    const key = normalizeKey(text);
    if (!key) return { handled: false, success: false, steps: [], message: "" };
    const picked = parsePickNumber(text, lastOutcome);
    if (picked) {
      inFlight.add(key);
      try {
        const step = { action: "open_path", args: { path: picked.path }, source: "pick" };
        if (typeof perform !== "function") {
          return storeLast({ handled: true, success: false, steps: [step], results: [], message: "No executor is available" });
        }
        const result = { action: "open_path", ...(await perform({ action: "open_path", args: step.args, utterance: text }, { autoRunTrusted: options.autoRunTrusted !== false, confirmed: options.confirmed })) };
        remember(key);
        return storeLast({
          handled: true,
          success: result.success !== false,
          steps: [step],
          results: [result],
          message: result.message || `Opened ${picked.path} in File Explorer`,
          source: "pick",
        });
      } finally {
        inFlight.delete(key);
      }
    }
    if (isMetaIntent(text)) {
      const message = formatMetaExplanation(text, lastOutcome);
      return { handled: true, success: true, explanation: true, steps: [], message, source: "meta" };
    }
    if (inFlight.has(key) || wasRecent(key)) {
      return {
        handled: true,
        success: true,
        deduped: true,
        steps: [],
        message: "Already handling that command.",
      };
    }
    inFlight.add(key);
    try {
      const planned = await plan(text, options);
      if (planned.metaIntent) {
        const message = formatMetaExplanation(text, lastOutcome);
        return { handled: true, success: true, explanation: true, steps: [], message, source: "meta" };
      }
      if (!planned.steps.length) {
        return { handled: false, success: false, steps: [], source: planned.source, message: "" };
      }
      const results = [];
      for (let i = 0; i < planned.steps.length; i++) {
        const step = planned.steps[i];
        if (typeof options.onProgress === "function") {
          options.onProgress({
            phase: "step",
            current: i + 1,
            total: planned.steps.length,
            text: `Working... step ${i + 1}/${planned.steps.length}`,
          });
        }
        let result;
        if (step.action === "submit_page") {
          result = await executeSubmitPage(step);
        } else if (step.type === "mcp" || step.action === "mcp") {
          result = await executeMcpStep(step, options);
        } else if (typeof perform === "function") {
          result = await perform(
            { action: step.action, args: step.args, utterance: text },
            { autoRunTrusted: options.autoRunTrusted !== false, confirmed: options.confirmed }
          );
        } else {
          result = { success: false, error: "No executor is available", action: step.action };
        }
        result = { action: step.action, ...result };
        const verified = await verifyStep(step, result);
        if (!verified.ok) {
          const message = verified.message || result.message || result.error || "The command failed.";
          return storeLast({
            handled: true,
            success: false,
            steps: planned.steps,
            results: results.concat(result),
            message,
            source: planned.source,
          });
        }
        results.push(result);
        if (step.action === "find_path") {
          const matches = result.matches || [];
          if (result.missingWithin || matches.length !== 1) {
            remember(key);
            return storeLast({
              handled: true,
              success: true,
              steps: planned.steps.slice(0, results.length),
              results,
              message: result.message || formatFindOutcome(result),
              source: planned.source,
            });
          }
          const next = planned.steps[planned.steps.indexOf(step) + 1];
          if (!next || next.action !== "open_path") {
            planned.steps.splice(planned.steps.indexOf(step) + 1, 0, {
              action: "open_path",
              args: { path: matches[0].path },
              source: "find_path",
            });
          } else if (!next.args.path) {
            next.args.path = matches[0].path;
          }
        }
      }
      remember(key);
      return storeLast({
        handled: true,
        success: results.every((row) => row.success !== false),
        steps: planned.steps,
        results,
        message: formatOutcome(text, planned.steps, results),
        source: planned.source,
      });
    } finally {
      inFlight.delete(key);
    }
  }

  function reset() {
    recent.clear();
    inFlight.clear();
    lastOutcome = null;
  }

  function getLastOutcome() {
    return lastOutcome;
  }

  return {
    orchestrate,
    plan,
    reset,
    getLastOutcome,
    sanitizePlan,
    attachFinishSteps,
    formatOutcome,
    isRawUtteranceSearch,
    isCalendarPrefillStep,
  };
}

module.exports = {
  createOrchestrator,
  sanitizePlan,
  attachFinishSteps,
  formatOutcome,
  formatCalendarOutcome,
  isRawUtteranceSearch,
  isCalendarPrefillStep,
  isSearchUrl,
  isMessagingStep,
  normalizeKey,
  NEVER_AUTOSUBMIT_APP_IDS,
  DEDUPE_MS,
};

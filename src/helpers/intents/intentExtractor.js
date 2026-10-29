// Overlay: extract a structured calendar event / reminder / to-do from dictated text.
// Calls the local Ollama API (http://localhost:11434/v1/chat/completions) with a
// tight JSON-only prompt and validates the result before returning it.
// Fails silently: any error or timeout returns null.

"use strict";

const OLLAMA_BASE = "http://localhost:11434/v1";
const MODEL = process.env.OVERLAY_INTENT_MODEL || "qwen3.5:4b-q4_K_M";
// A cold model load can take a few seconds; this runs after paste, so it never delays it.
const TIMEOUT_MS = 6000;
const MIN_CONFIDENCE = 0.6;

/**
 * Build the extraction prompt. Kept in English so the local model works well
 * regardless of the user's UI language.
 *
 * @param {string} text  — the dictated text
 * @param {string} now   — ISO 8601 string for current date-time with offset
 * @param {string} tz    — IANA timezone name, e.g. "Asia/Kolkata"
 * @returns {string}
 */
function buildPrompt(text, now, tz) {
  return (
    `Current date-time: ${now}\nTimezone: ${tz}\n\n` +
    `Dictated text: "${text}"\n\n` +
    `Classify the dictated text as a calendar event, reminder, or to-do. ` +
    `Reply with ONLY a JSON object and nothing else. Schema:\n` +
    `{"type":"event"|"reminder"|"todo","title":"short title","start":"ISO 8601 with offset","end":"ISO 8601 or null","confidence":0..1}\n\n` +
    `Rules:\n` +
    `- type: "event" for meetings/calls, "reminder" for remind-me/alarm, "todo" for tasks/deadlines.\n` +
    `- title: concise noun phrase (≤8 words), no filler, no time.\n` +
    `- start: must include timezone offset. A bare number like "5" means next 5:00 PM (or AM if PM is already past). "kal"=tomorrow, "parso"=day-after-tomorrow, "aaj"=today.\n` +
    `- end: null unless explicitly stated. Default event length is 30 minutes.\n` +
    `- confidence: your estimate 0–1 that this is a real future calendar entry.\n` +
    `- Reject past events (confidence < 0.6) unless they are about a future follow-up.\n` +
    `Output ONLY the JSON object, no markdown, no explanation.`
  );
}

/**
 * Validate the raw parsed object from the model.
 * Returns a cleaned object or null.
 *
 * @param {unknown} raw
 * @param {number}  nowMs  — epoch millis for "in the past?" check
 * @returns {{ type: string, title: string, start: string, end: string|null, confidence: number }|null}
 */
function validate(raw, nowMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const type = raw.type;
  if (!["event", "reminder", "todo"].includes(type)) return null;

  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 120) : null;
  if (!title) return null;

  const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
  if (confidence < MIN_CONFIDENCE) return null;

  // start is required for events and reminders, optional for todos
  const startRaw = typeof raw.start === "string" ? raw.start.trim() : null;
  let start = null;
  if (startRaw) {
    const parsed = Date.parse(startRaw);
    if (!Number.isFinite(parsed)) return null;
    // Reject times clearly in the past (more than 5 minutes ago)
    if (parsed < nowMs - 5 * 60 * 1000 && type !== "todo") return null;
    start = new Date(parsed).toISOString();
  } else if (type !== "todo") {
    // event and reminder must have a start time
    return null;
  }

  const endRaw = typeof raw.end === "string" ? raw.end.trim() : null;
  let end = null;
  if (endRaw) {
    const parsed = Date.parse(endRaw);
    if (Number.isFinite(parsed)) {
      end = new Date(parsed).toISOString();
    }
  }
  // Default event length: 30 min
  if (type === "event" && start && !end) {
    end = new Date(Date.parse(start) + 30 * 60 * 1000).toISOString();
  }

  return { type, title, start, end, confidence };
}

/**
 * Extract calendar intent from `text`.
 *
 * @param {object} opts
 * @param {string}   opts.text    — dictated text
 * @param {string}   [opts.ollamaBase]  — override Ollama base URL (tests)
 * @param {Function} [opts.fetchImpl]   — override fetch (tests)
 * @param {number}   [opts.nowMs]       — override Date.now() (tests)
 * @param {string}   [opts.nowIso]      — override ISO now string (tests)
 * @param {string}   [opts.tz]          — override timezone (tests)
 * @returns {Promise<{type,title,start,end,confidence}|null>}
 */
async function extractIntent({
  text,
  ollamaBase = OLLAMA_BASE,
  fetchImpl = fetch,
  nowMs = Date.now(),
  nowIso = new Date(nowMs).toISOString(),
  tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
} = {}) {
  const prompt = buildPrompt(text, nowIso, tz);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${ollamaBase}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: 0.1,
        // Ollama's OpenAI-compatible endpoint ignores options.think; this is the
        // field it honours to skip the thinking pass (qwen3.5 thinks by default).
        reasoning_effort: "none",
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    // Strip markdown fences if the model wrapped the JSON anyway
    const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }
    return validate(parsed, nowMs);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { extractIntent, buildPrompt, validate };

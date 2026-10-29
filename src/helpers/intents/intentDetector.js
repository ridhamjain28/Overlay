// Overlay: fast local text check for calendar-worthy phrases.
// No model call, no network, pure regex. Returns true only when BOTH a
// trigger word group AND a time/date pattern are present.
//
// This gate runs on every dictation after pasting — missing a real intent is
// fine, catching a false positive wastes one cheap model call. Keep it fast.

"use strict";

// ── trigger words ────────────────────────────────────────────────────────────
// English
const EN_WORDS =
  /\b(?:meeting|call|sync|catch[- ]?up|stand[- ]?up|standup|huddle|webinar|conference|appointment|interview|demo|check[- ]?in|1[- ]?on[- ]?1|one[- ]?on[- ]?one|remind(?:er)?|alarm|deadline|due|todo|to[- ]do|task|schedule)\b/i;

// Hinglish / Hindi romanised
const HI_WORDS =
  /\b(?:meeting|baithak|mulaqat|miting|yaad dilana|yaad karna|yaad rakhna|deadline|kaam|task|remind|appointment|interview)\b/i;

// Negative lookahead phrases — past tense cues that should suppress the toast
// ("I had a meeting yesterday", "we had a call last week")
const PAST_SUPPRESSORS =
  /\b(?:had|was|were|attended|missed|cancelled|canceled|skipped|yesterday|last\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday))\b/i;

// ── time / date patterns ─────────────────────────────────────────────────────
// Must be present alongside a trigger word
const TIME_PATTERNS = [
  // "at 5", "at 5pm", "at 5:30", "at 17:00", "at 5 PM"
  /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?\b/i,
  // "5pm", "5 pm", "17:00"
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
  // "5 baje", "paanch baje", "5:30 baje"
  /\b(?:\d{1,2}(?::\d{2})?|ek|do|teen|chaar|paanch|chhe|saat|aath|nau|das|gyarah|barah)\s+baje\b/i,
  // English relatives
  /\b(?:tomorrow|tonight|today|this\s+(?:morning|afternoon|evening|weekend)|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+\d+\s+(?:minute|hour|day|week)s?)\b/i,
  // Hinglish relatives
  /\b(?:kal|parso|aaj|is\s+(?:hafta|week)|agli?\s+(?:week|hafta|baar))\b/i,
];

/**
 * Returns true when `text` looks like it may describe a calendar event,
 * reminder, or to-do that is worth extracting.
 *
 * @param {string} text
 * @returns {boolean}
 */
function mightContainIntent(text) {
  if (typeof text !== "string" || text.length < 5) return false;

  const hasTrigger = EN_WORDS.test(text) || HI_WORDS.test(text);
  if (!hasTrigger) return false;

  const hasTime = TIME_PATTERNS.some((re) => re.test(text));
  if (!hasTime) return false;

  // Suppress obvious past-tense reports ("I had a meeting yesterday")
  if (PAST_SUPPRESSORS.test(text)) {
    // Only suppress if the suppressor clearly precedes the trigger, not the
    // other way around — a crude heuristic that keeps "remind me, I had a
    // call yesterday I need to follow up tomorrow" alive.
    const suppressIdx = text.search(PAST_SUPPRESSORS);
    const triggerIdx = Math.min(
      text.search(EN_WORDS) === -1 ? Infinity : text.search(EN_WORDS),
      text.search(HI_WORDS) === -1 ? Infinity : text.search(HI_WORDS)
    );
    if (suppressIdx < triggerIdx) return false;
  }

  return true;
}

module.exports = { mightContainIntent };

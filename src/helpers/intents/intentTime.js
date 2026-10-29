// Overlay: local-time helpers for dictation intents.
// The model is told the user's local date, weekday and offset, and its reply is
// checked against the words actually spoken ("kal", "next Monday", "4 baje",
// "11am") so a wrong day or a copied seconds value cannot reach the calendar.

"use strict";

const MINUTE_MS = 60 * 1000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Weekday words, English and romanised Hindi, mapped to 0 (Sunday) .. 6.
const WEEKDAY_WORDS = [
  [/\b(?:sunday|ravivar|itvar|itwar)\b/i, 0],
  [/\b(?:monday|somvar|somwar)\b/i, 1],
  [/\b(?:tuesday|mangalvar|mangalwar)\b/i, 2],
  [/\b(?:wednesday|budhvar|budhwar)\b/i, 3],
  [/\b(?:thursday|guruvar|guruwar|veervar|brihaspativar)\b/i, 4],
  [/\b(?:friday|shukravar|shukrawar)\b/i, 5],
  [/\b(?:saturday|shanivar|shaniwar)\b/i, 6],
];

const HINDI_NUMBERS = {
  ek: 1,
  do: 2,
  teen: 3,
  chaar: 4,
  char: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  che: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  gyarah: 11,
  barah: 12,
};

const RELATIVE_TIME =
  /\b(?:in\s+(?:an?|\d+)\s*(?:min(?:ute)?s?|hours?|hrs?)|\d+\s*(?:min(?:ute)?s?|ghante|ghanta)\s*(?:mein|me|baad))\b/i;

function zonedParts(ms, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: DAY_NAMES.indexOf(parts.weekday),
  };
}

// Minutes the zone is ahead of UTC at `ms` (330 for Asia/Kolkata).
function offsetMinutes(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const pad = (n) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const pad2 = (n) => String(n).padStart(2, "0");

// "2026-10-29T19:15:00+05:30" for the user's zone, whole minutes.
function localIso(ms, tz) {
  const p = zonedParts(ms, tz);
  return (
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:00` +
    formatOffset(offsetMinutes(ms, tz))
  );
}

// Epoch millis for a wall-clock time in `tz`.
function zonedToUtcMs({ year, month, day, hour, minute }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMinutes(guess, tz) * MINUTE_MS;
  const second = guess - offsetMinutes(first, tz) * MINUTE_MS;
  return second;
}

function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// "Friday 2026-10-30 (tomorrow, kal), Saturday 2026-10-31 (parso), ..."
function upcomingDays(nowMs, tz, count = 7) {
  const today = zonedParts(nowMs, tz);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const d = addDays(today, i);
    const weekday = DAY_NAMES[(today.weekday + i) % 7];
    const tag = i === 1 ? " (tomorrow, kal)" : i === 2 ? " (day after tomorrow, parso)" : "";
    out.push(`${weekday} ${d.year}-${pad2(d.month)}-${pad2(d.day)}${tag}`);
  }
  return out.join(", ");
}

// Days from today that the spoken words point at, or null when they name no day.
function spokenDayOffset(text, todayWeekday) {
  if (/\b(?:day\s+after\s+tomorrow|parso|parson)\b/i.test(text)) return 2;
  if (/\b(?:tomorrow|kal)\b/i.test(text)) return 1;
  if (/\b(?:today|tonight|aaj|this\s+(?:morning|afternoon|evening))\b/i.test(text)) return 0;
  for (const [re, target] of WEEKDAY_WORDS) {
    const match = text.match(re);
    if (!match) continue;
    const diff = (target - todayWeekday + 7) % 7;
    if (diff !== 0) return diff;
    const before = text.slice(0, match.index);
    return /\bthis\s+$/i.test(before) ? 0 : 7;
  }
  return null;
}

// Clock time the words state: { hour, minute, meridiem } with meridiem "am" | "pm" | null.
function spokenTime(text) {
  let m = text.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?![\w.])/i);
  if (m) return clock(Number(m[1]), Number(m[2]), meridiemOf(m[3]) || hindiMeridiem(text));
  m = text.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![\w])/i);
  if (m) return clock(Number(m[1]), 0, meridiemOf(m[2]));
  if (/\bnoon\b/i.test(text)) return clock(12, 0, "pm");
  m = text.match(
    /\b(saadhe|sadhe|sava|savaa|paune)?\s*(\d{1,2}|ek|do|teen|chaar|char|paanch|panch|chhe|che|saat|aath|nau|das|gyarah|barah)\s+baje\b/i
  );
  if (m) {
    let hour = /^\d+$/.test(m[2]) ? Number(m[2]) : HINDI_NUMBERS[m[2].toLowerCase()];
    let minute = 0;
    const mod = (m[1] || "").toLowerCase();
    if (mod.startsWith("sa") && mod !== "sava" && mod !== "savaa") minute = 30;
    else if (mod.startsWith("sava")) minute = 15;
    else if (mod === "paune") {
      hour = hour === 1 ? 12 : hour - 1;
      minute = 45;
    }
    return clock(hour, minute, hindiMeridiem(text));
  }
  if (/\b(?:dedh)\s+baje\b/i.test(text)) return clock(1, 30, hindiMeridiem(text));
  if (/\b(?:dhai|dhaai)\s+baje\b/i.test(text)) return clock(2, 30, hindiMeridiem(text));
  m = text.match(/\bat\s+(\d{1,2})\b(?!\s*(?:%|min|minute|hour|hr|day|week|percent))/i);
  if (m) return clock(Number(m[1]), 0, null);
  return null;
}

function meridiemOf(s) {
  if (!s) return null;
  return s.toLowerCase().startsWith("p") ? "pm" : "am";
}

function hindiMeridiem(text) {
  if (/\b(?:subah|savere|morning)\b/i.test(text)) return "am";
  if (/\b(?:dopahar|shaam|sham|evening|afternoon|tonight|raat)\b/i.test(text)) return "pm";
  return null;
}

function clock(hour, minute, meridiem) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute, meridiem: hour > 12 ? null : meridiem };
}

// 24-hour clock for a spoken time, using the model's hour to settle a bare "4".
function resolveHour({ hour, meridiem }, modelHour) {
  if (meridiem === "am") return hour % 12;
  if (meridiem === "pm") return (hour % 12) + 12;
  if (hour === 0 || hour > 12) return hour;
  if (Number.isInteger(modelHour) && modelHour % 12 === hour % 12) return modelHour;
  if (hour === 12) return 12;
  return hour <= 7 ? hour + 12 : hour;
}

const floorToMinute = (ms) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/**
 * Bring the model's start in line with the words spoken, in the user's zone.
 * Always returns whole minutes.
 *
 * @param {number} startMs  start the model proposed
 * @param {string} text     the dictated text
 * @param {number} nowMs
 * @param {string} tz       IANA zone
 * @returns {number}
 */
function reconcileStart(startMs, text, nowMs, tz) {
  if (typeof text !== "string" || !text || RELATIVE_TIME.test(text)) {
    return floorToMinute(startMs);
  }
  const model = zonedParts(startMs, tz);
  const today = zonedParts(nowMs, tz);
  const dayOffset = spokenDayOffset(text, today.weekday);
  let date = dayOffset === null ? model : addDays(today, dayOffset);
  const said = spokenTime(text);
  const hour = said ? resolveHour(said, model.hour) : model.hour;
  const minute = said ? said.minute : model.minute;
  let result = zonedToUtcMs({ ...date, hour, minute }, tz);
  // "at 5pm" with no day, after 5pm today, means tomorrow.
  if (dayOffset === null && said && result < nowMs - 5 * MINUTE_MS) {
    date = addDays(date, 1);
    result = zonedToUtcMs({ ...date, hour, minute }, tz);
  }
  return floorToMinute(result);
}

module.exports = {
  DAY_NAMES,
  zonedParts,
  offsetMinutes,
  formatOffset,
  localIso,
  zonedToUtcMs,
  upcomingDays,
  spokenDayOffset,
  spokenTime,
  resolveHour,
  reconcileStart,
  floorToMinute,
};

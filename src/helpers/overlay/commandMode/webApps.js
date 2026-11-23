// Web app shortcuts, Google Calendar event templates, and Gmail compose URLs.
// Pure functions — no Electron, no network.

const { resolveBrowserAlias } = require("./browserSearch");

function trimText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEB_APPS = [
  { name: "google calendar", aliases: ["google calendar", "gcal", "g calendar"], url: "https://calendar.google.com/" },
  { name: "gmail", aliases: ["gmail", "google mail", "google email"], url: "https://mail.google.com/" },
  { name: "youtube", aliases: ["youtube.com", "youtube", "yt"], url: "https://www.youtube.com/" },
  { name: "google maps", aliases: ["google maps", "gmaps", "maps"], url: "https://maps.google.com/" },
  { name: "google drive", aliases: ["google drive", "gdrive", "drive"], url: "https://drive.google.com/" },
  { name: "google docs", aliases: ["google docs", "gdocs", "docs"], url: "https://docs.google.com/" },
  { name: "whatsapp web", aliases: ["whatsapp web", "wa web", "whatsapp"], url: "https://web.whatsapp.com/" },
];

const OPEN_VERB_RE = "(?:open|launch|start|go to|goto|visit|kholo|khol do|khol dena|chalao|chala do)";
const BROWSER_TAIL_RE =
  "(?:google\\s+)?chrome|microsoft\\s+edge|msedge|edge|brave(?:\\s+browser)?|mozilla(?:\\s+firefox)?|firefox|opera(?:\\s+browser)?|(?:the\\s+)?(?:default\\s+)?browsers?|my browser";

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(aliases) {
  return aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");
}

const WEB_APP_RE = aliasPattern(WEB_APPS.flatMap((app) => app.aliases));

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLocalStamp({ year, month, day, hour, minute, second = 0 }) {
  return `${year}${pad2(month)}${pad2(day)}T${pad2(hour)}${pad2(minute)}${pad2(second)}`;
}

function resolveWebApp(raw) {
  const n = trimText(raw).toLowerCase();
  if (!n) return null;
  for (const app of WEB_APPS) {
    if (app.aliases.some((alias) => alias === n)) return app;
  }
  return null;
}

function buildCalendarTemplateUrl({ title, start, end }) {
  const text = encodeURIComponent(String(title || "").trim());
  const dates = `${formatLocalStamp(start)}/${formatLocalStamp(end)}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${dates}`;
}

function buildGmailComposeUrl({ to, subject, body }) {
  const params = new URLSearchParams();
  params.set("view", "cm");
  params.set("fs", "1");
  if (to) params.set("to", to);
  if (subject) params.set("su", subject);
  if (body) params.set("body", body);
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function ymdFromDate(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function parseEventDate(text, now = new Date()) {
  const raw = trimText(text);
  const tomorrow = /\btomorrow\b/i.test(raw);
  if (tomorrow) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return ymdFromDate(d);
  }
  if (/\btoday\b/i.test(raw)) return ymdFromDate(now);

  const dmy = raw.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }

  const named = raw.match(
    /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s*,?\s*(\d{4}))?/i
  );
  if (named) {
    const day = Number(named[1]);
    const month = MONTHS[named[2].toLowerCase()];
    let year = named[3] ? Number(named[3]) : now.getFullYear();
    if (!named[3]) {
      const candidate = new Date(year, month - 1, day);
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (candidate < startOfToday) year += 1;
    }
    if (month && day >= 1 && day <= 31) return { year, month, day };
  }
  return null;
}

const MERIDIEM_SRC = "a\\.?m\\.?|p\\.?m\\.?";

function merNorm(mer) {
  return String(mer || "").toLowerCase().replace(/\./g, "");
}

function merToHour(hour, minute, mer) {
  let h = Number(hour);
  const m = Number(minute || 0);
  const meridem = merNorm(mer);
  if (meridem === "pm" && h < 12) h += 12;
  if (meridem === "am" && h === 12) h = 0;
  return { hour: h, minute: m };
}

function parseEventTimeRange(text) {
  const raw = trimText(text);
  // Dates like 24-11-2026 must not be read as a time range.
  const masked = raw.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ");
  const mer = `(${MERIDIEM_SRC})`;
  const m = masked.match(
    new RegExp(
      `(?:from\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*${mer}?\\s*(?:-|–|—|to)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*${mer}?`,
      "i"
    )
  );
  if (!m) return null;
  let startMer = merNorm(m[3]);
  let endMer = merNorm(m[6]);
  if (!startMer && endMer) startMer = endMer;
  if (!endMer && startMer) endMer = startMer;
  const startNum = Number(m[1]);
  const endNum = Number(m[4]);
  const looks24h = !startMer && !endMer && (startNum > 12 || endNum > 12 || m[2] || m[5]);
  if (!startMer && !endMer && !looks24h) return null;
  const start = merToHour(m[1], m[2], startMer);
  const end = merToHour(m[4], m[5], endMer);
  if (start.hour > 23 || end.hour > 23 || start.minute > 59 || end.minute > 59) return null;
  return { start, end };
}

function parseEventSingleTime(text) {
  const raw = trimText(text);
  const masked = raw.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ");
  const mer = `(${MERIDIEM_SRC})`;
  const m = masked.match(new RegExp(`(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*${mer}\\b`, "i"));
  if (!m) return null;
  const start = merToHour(m[1], m[2], merNorm(m[3]));
  if (start.hour > 23 || start.minute > 59) return null;
  const endHour = start.hour + 1;
  const end = endHour <= 23
    ? { hour: endHour, minute: start.minute }
    : { hour: 23, minute: 59 };
  return { start, end };
}

function parseEventTimes(text) {
  return parseEventTimeRange(text) || parseEventSingleTime(text);
}

function parseEventTitle(text) {
  const raw = trimText(text);
  const quoted = raw.match(/["“](.+?)["”]/);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  const labelRe = new RegExp(
    `\\b(?:titled|called|named|about|for)\\s+(?:an?\\s+|the\\s+)?(?!\\d)(.+?)(?=\\s+(?:on|from|at|tomorrow|today|tonight)\\b|$)`,
    "ig"
  );
  let match;
  while ((match = labelRe.exec(raw))) {
    const title = match[1].replace(/[.,;:–—-]+$/g, "").trim();
    if (!title) continue;
    if (parseEventDate(title, new Date(2000, 0, 1))) continue;
    return title;
  }
  const noun = raw.match(/\b(meeting|appointment|reminder|party|event)\b/i);
  if (noun) {
    const word = noun[1];
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return "";
}

function looksLikeCalendarEvent(text) {
  const raw = trimText(text);
  if (!/\b(calendar|event|appointment|meeting|reminder)\b/i.test(raw)) return false;
  return (
    /\b(add|create|make|schedule|book|put|set\s*up)\b.{0,60}\b(event|appointment|meeting|reminder)\b/i.test(
      raw
    ) ||
    /\b(event|appointment|meeting|reminder)\b.{0,40}\b(on|for|at|from|tomorrow|today)\b/i.test(raw)
  );
}

function parseCalendarEvent(text, { now = new Date() } = {}) {
  const raw = trimText(text);
  if (!looksLikeCalendarEvent(raw)) return null;
  const date = parseEventDate(raw, now);
  const title = parseEventTitle(raw);
  if (!date || !title) return null;
  const range = parseEventTimes(raw);
  const startTime = range ? range.start : { hour: 9, minute: 0 };
  const endTime = range ? range.end : { hour: startTime.hour + 1, minute: startTime.minute };
  const start = { ...date, ...startTime, second: 0 };
  const end = { ...date, ...endTime, second: 0 };
  return {
    action: "open_url",
    args: { url: buildCalendarTemplateUrl({ title, start, end }) },
    confidence: 0.93,
  };
}

function parseWebAppOpen(text) {
  const raw = trimText(text);
  const re = new RegExp(
    `^${OPEN_VERB_RE}\\s+(?:the\\s+)?(${WEB_APP_RE})(?:\\s+(?:in|on|with|using)\\s+(${BROWSER_TAIL_RE}))?$`,
    "i"
  );
  const m = raw.match(re);
  if (!m) return null;
  const app = resolveWebApp(m[1]);
  if (!app) return null;
  const args = { url: app.url };
  if (m[2]) {
    const product = resolveBrowserAlias(m[2]);
    if (product === "default") args.browser = "browser";
    else if (product) args.browser = product;
  }
  return { action: "open_url", args, confidence: 0.92 };
}

function parseGmailCompose(text) {
  const raw = trimText(text);
  if (/^(?:open|launch|start|kholo|chalao)\s+/i.test(raw) && !/\bgmail\b/i.test(raw)) return null;
  const m = raw.match(
    /^(?:(?:please|pls|plz)\s+)?(?:compose|write|draft|send)\s+(?:me\s+)?(?:an?\s+)?(?:email|mail|gmail)\s+to\s+(.+?)\s+(?:about|regarding|re|on the subject of)\s+(.+)$/i
  );
  if (!m) return null;
  const to = trimText(m[1]);
  const subject = trimText(m[2]).replace(/[.?!]+$/g, "");
  if (!to || !subject) return null;
  return {
    action: "compose_email",
    args: {
      to,
      subject,
      prompt: `Write an email to ${to} about ${subject}. Output only the email body as plain text, with no subject line and no preamble.`,
    },
    confidence: 0.9,
  };
}

module.exports = {
  WEB_APPS,
  buildCalendarTemplateUrl,
  buildGmailComposeUrl,
  formatLocalStamp,
  parseEventDate,
  parseEventTimeRange,
  parseEventSingleTime,
  parseEventTimes,
  parseEventTitle,
  parseCalendarEvent,
  parseWebAppOpen,
  parseGmailCompose,
  resolveWebApp,
};

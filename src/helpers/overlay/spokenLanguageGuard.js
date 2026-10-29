// Overlay: keeps transcription inside the languages the user said they speak
// (settings.spokenLanguages) while the transcription language is Auto-detect.
//
// - One spoken language: transcription is pinned to it.
// - Two or more: no batch provider accepts a list of allowed languages (Whisper,
//   whisper.cpp and the OpenAI-compatible APIs take one language or none), so
//   the transcript's writing system is checked instead. When most of its
//   letters are in a script none of the allowed languages use (Urdu letters for
//   a Hindi and English speaker, say), the recording is transcribed once more
//   with an allowed language pinned.
//
// Limits: two languages that share a script (Spanish heard as English) cannot
// be told apart this way, and streaming transcription is not checked.

const SCRIPT_PATTERNS = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
  ["Bengali", /\p{Script=Bengali}/u],
  ["Gurmukhi", /\p{Script=Gurmukhi}/u],
  ["Gujarati", /\p{Script=Gujarati}/u],
  ["Oriya", /\p{Script=Oriya}/u],
  ["Tamil", /\p{Script=Tamil}/u],
  ["Telugu", /\p{Script=Telugu}/u],
  ["Kannada", /\p{Script=Kannada}/u],
  ["Malayalam", /\p{Script=Malayalam}/u],
  ["Sinhala", /\p{Script=Sinhala}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Lao", /\p{Script=Lao}/u],
  ["Khmer", /\p{Script=Khmer}/u],
  ["Myanmar", /\p{Script=Myanmar}/u],
  ["Georgian", /\p{Script=Georgian}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Ethiopic", /\p{Script=Ethiopic}/u],
  ["Tibetan", /\p{Script=Tibetan}/u],
  ["Han", /\p{Script=Han}/u],
  ["Hiragana", /\p{Script=Hiragana}/u],
  ["Katakana", /\p{Script=Katakana}/u],
  ["Hangul", /\p{Script=Hangul}/u],
];

const LATIN = [
  "af",
  "az",
  "br",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "en",
  "es",
  "et",
  "eu",
  "fi",
  "fil",
  "fo",
  "fr",
  "ga",
  "gl",
  "ha",
  "haw",
  "hr",
  "ht",
  "hu",
  "id",
  "is",
  "it",
  "jw",
  "jv",
  "la",
  "lb",
  "ln",
  "lt",
  "lv",
  "mg",
  "mi",
  "ms",
  "mt",
  "nl",
  "nn",
  "no",
  "nb",
  "oc",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "sn",
  "so",
  "sq",
  "su",
  "sv",
  "sw",
  "tk",
  "tl",
  "tr",
  "uz",
  "vi",
  "yo",
  "yue-Latn",
  "zu",
];
const CYRILLIC = ["ba", "be", "bg", "kk", "ky", "mk", "mn", "ru", "sr", "tg", "tt", "uk"];
const ARABIC = ["ar", "fa", "ps", "sd", "ug", "ur"];
const DEVANAGARI = ["hi", "mr", "ne", "sa"];

const LANGUAGE_SCRIPTS = new Map([
  ...LATIN.map((code) => [code, ["Latin"]]),
  ...CYRILLIC.map((code) => [code, ["Cyrillic"]]),
  ...ARABIC.map((code) => [code, ["Arabic"]]),
  ...DEVANAGARI.map((code) => [code, ["Devanagari"]]),
  ["bn", ["Bengali"]],
  ["as", ["Bengali"]],
  ["pa", ["Gurmukhi"]],
  ["gu", ["Gujarati"]],
  ["or", ["Oriya"]],
  ["ta", ["Tamil"]],
  ["te", ["Telugu"]],
  ["kn", ["Kannada"]],
  ["ml", ["Malayalam"]],
  ["si", ["Sinhala"]],
  ["th", ["Thai"]],
  ["lo", ["Lao"]],
  ["km", ["Khmer"]],
  ["my", ["Myanmar"]],
  ["ka", ["Georgian"]],
  ["hy", ["Armenian"]],
  ["he", ["Hebrew"]],
  ["yi", ["Hebrew"]],
  ["el", ["Greek"]],
  ["am", ["Ethiopic"]],
  ["bo", ["Tibetan"]],
  ["zh", ["Han"]],
  ["yue", ["Han"]],
  ["ja", ["Han", "Hiragana", "Katakana"]],
  ["ko", ["Hangul", "Han"]],
]);

// Fewer letters than this is too little text to judge.
const MIN_LETTERS = 4;

export function baseLanguage(code) {
  if (typeof code !== "string") return "";
  const trimmed = code.trim();
  if (!trimmed || trimmed === "auto") return "";
  return trimmed.split("-")[0].toLowerCase();
}

/** Writing systems a spoken-language entry is written in, or null when unknown. */
export function scriptsForLanguage(code) {
  if (typeof code !== "string" || !code.trim()) return null;
  if (/-Latn$/i.test(code.trim())) return ["Latin"];
  const base = baseLanguage(code);
  return LANGUAGE_SCRIPTS.get(base) ?? null;
}

/**
 * The spoken languages that limit transcription, one entry per base language
 * in the user's order. Empty when the user picked a transcription language
 * themselves, when translating, or when no spoken languages are saved.
 */
export function allowedSpokenLanguages(settings = {}, { translationRequested = false } = {}) {
  if (translationRequested) return [];
  const preferred =
    typeof settings.preferredLanguage === "string" && settings.preferredLanguage.trim()
      ? settings.preferredLanguage.trim()
      : "auto";
  if (preferred !== "auto") return [];
  const list = Array.isArray(settings.spokenLanguages) ? settings.spokenLanguages : [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const base = baseLanguage(entry);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    result.push(entry.trim());
  }
  return result;
}

/** The one language to pin transcription to, or null when there isn't exactly one. */
export function singleSpokenLanguage(settings = {}, options = {}) {
  const allowed = allowedSpokenLanguages(settings, options);
  return allowed.length === 1 ? allowed[0] : null;
}

/** Letter counts per script in `text`. */
export function scriptCounts(text) {
  const counts = new Map();
  if (typeof text !== "string") return counts;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    const match = SCRIPT_PATTERNS.find(([, pattern]) => pattern.test(char));
    const script = match ? match[0] : "Other";
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return counts;
}

/**
 * Every script any of the spoken languages may be written in, or null when one
 * of them uses a script this guard does not know (then nothing is checked).
 * Every entry for a language counts, so Hindi plus Hinglish allows Devanagari
 * and Latin.
 */
export function allowedScripts(settings = {}, options = {}) {
  const allowed = allowedSpokenLanguages(settings, options);
  if (allowed.length < 2) return null;
  const scripts = new Set();
  const list = Array.isArray(settings.spokenLanguages) ? settings.spokenLanguages : [];
  for (const entry of list) {
    if (!baseLanguage(entry)) continue;
    const forEntry = scriptsForLanguage(entry);
    if (!forEntry) return null;
    forEntry.forEach((s) => scripts.add(s));
  }
  return scripts;
}

/** True when most of the transcript's letters are in a script no allowed language uses. */
export function violatesSpokenLanguages(text, scripts) {
  if (!scripts || scripts.size === 0) return false;
  const counts = scriptCounts(text);
  let total = 0;
  let inside = 0;
  for (const [script, count] of counts) {
    total += count;
    if (scripts.has(script)) inside += count;
  }
  if (total < MIN_LETTERS) return false;
  return inside / total < 0.5;
}

/**
 * The allowed language to pin for the second attempt. A transcript in a
 * non-Latin script points at a non-Latin speaker, so the first allowed
 * language written in a non-Latin script wins; otherwise the first allowed.
 */
export function pickRetryLanguage(text, settings = {}, options = {}) {
  const allowed = allowedSpokenLanguages(settings, options);
  if (allowed.length === 0) return null;
  const counts = scriptCounts(text);
  let dominant = null;
  for (const [script, count] of counts) {
    if (!dominant || count > counts.get(dominant)) dominant = script;
  }
  if (dominant && dominant !== "Latin") {
    const list = Array.isArray(settings.spokenLanguages) ? settings.spokenLanguages : [];
    const nonLatin = list.find((entry) => {
      const scripts = scriptsForLanguage(entry);
      return scripts && !scripts.includes("Latin") && baseLanguage(entry);
    });
    if (nonLatin) return nonLatin.trim();
  }
  return allowed[0];
}

/**
 * Per-recording state for processAudio: checks the first transcript and asks
 * for one retry with a pinned language when it falls outside the allowed set.
 */
export function createSpokenLanguageGuard(settings = {}, options = {}) {
  const scripts = allowedScripts(settings, options);
  if (!scripts) return null;
  return {
    scripts,
    retryLanguage: null,
    attempts: 0,
    check(text, source) {
      if (this.attempts > 0 || this.retryLanguage) return false;
      if (source === "hinglish") return false;
      if (!violatesSpokenLanguages(text, scripts)) return false;
      this.retryLanguage = pickRetryLanguage(text, settings, options);
      return Boolean(this.retryLanguage);
    },
  };
}

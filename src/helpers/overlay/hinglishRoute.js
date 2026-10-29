// Overlay: decides when a recording goes to the Hinglish speech server.
//
// Hinglish (Roman script) always prefers it; Hindi uses it once it is
// installed; auto-detect only when the user said they speak Hindi. Any other
// language, or a server that is not ready, keeps the normal path.

const HINDI_CODES = new Set(["hi", "hi-Latn"]);

export function wantsHinglish({ language, spokenLanguages } = {}) {
  const lang = typeof language === "string" && language.trim() ? language.trim() : "auto";
  if (HINDI_CODES.has(lang)) return true;
  if (lang !== "auto") return false;
  return Array.isArray(spokenLanguages) && spokenLanguages.some((code) => HINDI_CODES.has(code));
}

export function shouldRouteToHinglish({ language, spokenLanguages, helperReady } = {}) {
  return helperReady === true && wantsHinglish({ language, spokenLanguages });
}

/**
 * Transcription language to save after onboarding's language step. Someone who
 * speaks Hindi, alone or with English, gets Hinglish (Roman script).
 */
export function preferredLanguageFromSpoken(spokenLanguages) {
  const list = Array.isArray(spokenLanguages) ? spokenLanguages.filter(Boolean) : [];
  if (list.includes("hi-Latn")) return "hi-Latn";
  const isEnglish = (code) => code === "en" || code.startsWith("en-");
  if (list.includes("hi") && list.every((code) => code === "hi" || isEnglish(code))) {
    return "hi-Latn";
  }
  return list.length === 1 ? list[0] : "auto";
}

// Overlay: picks which "answer source" answers a message.
//
//   local    – the model configured in Settings (default: Ollama qwen3.5:4b) with tools
//   openclaw – your OpenClaw gateway (web + actions through its own agent)
//   gemini   – Gemini with Google Search grounding (backup for web questions)
//
// "auto" keeps quick chat local, sends web/action requests to OpenClaw when it
// is reachable, and falls back to Gemini (web) or local (actions) otherwise.

export type AnswerSourceSetting = "auto" | "local" | "openclaw" | "gemini";
export type AnswerSource = "local" | "openclaw" | "gemini";
export type MessageIntent = "chat" | "web" | "action";

export interface AnswerSourcesStatus {
  openclaw: { configured: boolean; reachable: boolean; allowed?: boolean; unauthorized?: boolean };
  gemini: { configured: boolean };
  ollamaSearch?: { configured: boolean; usedToday: number; dailyCap: number };
  tavily?: { configured: boolean };
  searxng?: { configured: boolean };
}

export const ANSWER_SOURCE_SETTINGS: AnswerSourceSetting[] = [
  "auto",
  "local",
  "openclaw",
  "gemini",
];

export function normalizeAnswerSourceSetting(value: unknown): AnswerSourceSetting {
  return ANSWER_SOURCE_SETTINGS.includes(value as AnswerSourceSetting)
    ? (value as AnswerSourceSetting)
    : "auto";
}

const ACTION_PATTERNS: RegExp[] = [
  /^(please\s+)?(open|launch|start|close|lock|mute|unmute|play|pause|resume|skip|stop)\b/i,
  /\b(volume|brightness|screenshot|screen ?shot|lock (the )?screen|next (song|track)|previous (song|track))\b/i,
  /\b(kholo|khol do|band karo|chalao|bajao|awaaz|aawaz)\b/i,
];

const WEB_PATTERNS: RegExp[] = [
  /\b(search|google|look ?up|browse|find online|on the web|internet)\b/i,
  /\b(latest|today'?s?|tonight|yesterday|tomorrow|this week|right now|currently|current|recent|news|breaking|live)\b/i,
  /\b(weather|forecast|temperature|price|prices|stock|share price|exchange rate|score|scores|match|election|release date|launched?)\b/i,
  /\b(who (won|is the current)|what happened|when is|where is)\b/i,
  /\b(20[2-9]\d)\b/,
  /\b(aaj|abhi|kal ka|khabar|taaza)\b/i,
];

/** A cheap keyword guess at what a message needs. No model call. */
export function classifyIntent(text: string): MessageIntent {
  const t = (text || "").trim();
  if (!t) return "chat";
  if (ACTION_PATTERNS.some((re) => re.test(t))) return "action";
  if (WEB_PATTERNS.some((re) => re.test(t))) return "web";
  return "chat";
}

/**
 * Ordered list of sources to try for one message; later entries are
 * fallbacks used when an earlier one fails before producing any text.
 */
export function planAnswerSources(
  setting: AnswerSourceSetting,
  intent: MessageIntent,
  status: AnswerSourcesStatus | null
): AnswerSource[] {
  const openclawUp = !!status?.openclaw?.configured && !!status.openclaw.reachable;
  const geminiOk = !!status?.gemini?.configured;
  const plan: AnswerSource[] = [];
  const push = (s: AnswerSource) => {
    if (!plan.includes(s)) plan.push(s);
  };

  switch (setting) {
    case "local":
      push("local");
      break;
    case "openclaw":
      if (openclawUp) push("openclaw");
      if (geminiOk && intent === "web") push("gemini");
      push("local");
      break;
    case "gemini":
      if (geminiOk) push("gemini");
      push("local");
      break;
    case "auto":
    default:
      if (intent === "chat") {
        push("local");
      } else {
        if (openclawUp) push("openclaw");
        // Actions run best on the local model's allowlisted system_action tool.
        if (intent === "web" && geminiOk) push("gemini");
        push("local");
      }
  }
  return plan;
}

let statusCache: { at: number; value: AnswerSourcesStatus | null } = { at: 0, value: null };
const STATUS_CACHE_MS = 15000;

export async function getAnswerSourcesStatus(force = false): Promise<AnswerSourcesStatus | null> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.overlayAnswerSourcesStatus) return null;
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at < STATUS_CACHE_MS)
    return statusCache.value;
  try {
    const value = await api.overlayAnswerSourcesStatus();
    statusCache = { at: now, value };
    return value;
  } catch {
    return null;
  }
}

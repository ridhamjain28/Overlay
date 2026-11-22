import logger from "../../utils/logger";

const OVERLAY_DEFAULT_MODEL = "qwen3.5:4b-q4_K_M";
const OVERLAY_DEFAULT_OLLAMA_URL = "http://localhost:11434/v1";

export type CommandModeParser = "local" | "cloud";

export interface CommandModeSettings {
  enabled: boolean;
  autoRunTrusted: boolean;
  parser: CommandModeParser;
  model?: string;
  localBaseUrl?: string;
  cloudProvider?: string;
}

export interface CommandIntent {
  action: string;
  args: Record<string, string>;
  confidence: number;
  source?: string;
  steps?: Array<{ action: string; args: Record<string, string> }>;
  errorCode?: "TIMEOUT" | "PARSE_ERROR" | string;
  errorMessage?: string;
}

export type CommandModeOutcome =
  | { handled: false }
  | {
      handled: true;
      success: boolean;
      cancelled?: boolean;
      message: string;
      intent: CommandIntent;
    };

function api() {
  return typeof window !== "undefined" ? window.electronAPI : undefined;
}

/** Ask main to parse the text. Returns null if Command mode is off or IPC is missing. */
export async function parseCommandIntent(
  text: string,
  settings: CommandModeSettings
): Promise<CommandIntent | null> {
  if (!settings.enabled) return null;
  const fn = api()?.overlayCommandParse;
  if (!fn) return null;
  return fn({
    text,
    parser: settings.parser === "cloud" ? "cloud" : "local",
    model: settings.model || OVERLAY_DEFAULT_MODEL,
    localBaseUrl: settings.localBaseUrl || OVERLAY_DEFAULT_OLLAMA_URL,
    cloudProvider: settings.cloudProvider,
  });
}

export async function executeCommandIntent(
  intent: CommandIntent,
  settings: CommandModeSettings,
  confirmed = false
): Promise<{ success: boolean; message?: string; error?: string; code?: string }> {
  const fn = api()?.overlayCommandExecute;
  if (!fn) return { success: false, error: "Command mode needs the desktop app", code: "FAILED" };
  return fn({
    action: intent.action,
    args: intent.args,
    steps: intent.steps,
    confirmed,
    autoRunTrusted: settings.autoRunTrusted,
  });
}

/**
 * If Command mode is on and the text is a desktop command, run it (with the
 * main-process confirmation gate). Otherwise report that the assistant should
 * handle the turn as a normal chat message.
 */
export async function runCommandModeIfEnabled(
  text: string,
  settings: CommandModeSettings
): Promise<CommandModeOutcome> {
  if (!settings.enabled || !String(text || "").trim()) return { handled: false };
  let intent: CommandIntent;
  // Debug-only stage timing (durations and the intent source; never the text).
  const startedAt = Date.now();
  try {
    const parsed = await parseCommandIntent(text, settings);
    logger.debug(
      "STAGE_TIMING",
      { stage: "intent_parsed", ms: Date.now() - startedAt, source: parsed?.source },
      "perf"
    );
    if (!parsed) return { handled: false };
    if (parsed.errorCode === "TIMEOUT" || parsed.errorCode === "PARSE_ERROR") {
      console.warn("Command mode parse failed", parsed.errorCode, parsed.errorMessage);
      return {
        handled: true,
        success: false,
        message:
          parsed.errorCode === "TIMEOUT"
            ? "Couldn't understand that as a command in time — try 'open notepad'"
            : "Couldn't understand that as a command — try 'open notepad'",
        intent: parsed,
      };
    }
    if (parsed.action === "none") return { handled: false };
    intent = parsed;
  } catch (error) {
    console.warn("Command mode parse failed", error);
    return {
      handled: true,
      success: false,
      message: "Couldn't understand that as a command in time — try 'open notepad'",
      intent: { action: "none", args: {}, confidence: 0, errorCode: "PARSE_ERROR" },
    };
  }

  const executeStartedAt = Date.now();
  const result = await executeCommandIntent(intent, settings, false);
  logger.debug(
    "STAGE_TIMING",
    { stage: "action_executed", ms: Date.now() - executeStartedAt, totalMs: Date.now() - startedAt },
    "perf"
  );
  if (result.code === "CANCELLED") {
    return {
      handled: true,
      success: false,
      cancelled: true,
      message: result.error || "Cancelled. Nothing was run.",
      intent,
    };
  }
  return {
    handled: true,
    success: result.success,
    message: result.success
      ? result.message || "Done"
      : result.error || "The command could not be run",
    intent,
  };
}

import { create } from "zustand";
import {
  OVERLAY_DEFAULT_MODEL,
  OVERLAY_DEFAULT_OLLAMA_URL,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
  useSettingsStore,
  getSettings,
  type ResolvedLLMConfig,
} from "./settingsStore";
import type { InferenceScope } from "../config/inferenceScopes";
import { getTranscriptionProvider } from "../models/ModelRegistry";
import logger from "../utils/logger";

/**
 * One global AI provider for everything, with optional per-purpose overrides.
 *
 * The runtime still reads the per-feature keys in settingsStore (that is what
 * every request path, the main process and the migrations understand). This
 * module owns the single user-facing choice and writes it through to those keys
 * for every purpose that is not overridden, so nothing downstream changes.
 * Cloud API keys and the own-server key stay in the main process's secure
 * storage; nothing here logs or exposes a key.
 */

export type AiProviderKind = "local" | "own-server" | "cloud";
export type AiPurpose =
  | "dictationCleanup"
  | "assistantChat"
  | "commandParsing"
  | "speechToText"
  | "spokenReplies";

export const AI_PURPOSES: readonly AiPurpose[] = [
  "dictationCleanup",
  "assistantChat",
  "commandParsing",
  "speechToText",
  "spokenReplies",
];

/** Which inference scopes each LLM purpose drives. Others fall back to these. */
export const PURPOSE_SCOPES: Partial<Record<AiPurpose, InferenceScope[]>> = {
  dictationCleanup: ["dictationCleanup", "noteFormatting", "dictationTranslation"],
  assistantChat: ["chatIntelligence", "dictationAgent"],
};

/** Cloud providers that also offer speech-to-text, so "use global" can follow them. */
const CLOUD_STT_PROVIDERS = new Set(["openai", "groq", "mistral"]);

const STORAGE_KEY = "overlayAiProvider";
const MIGRATED_KEY = "overlayAiProviderMigrated";
const STT_APPLIED_KEY = "overlayAiSttFollowsGlobal";

export interface GlobalAiConfig {
  kind: AiProviderKind;
  /** Cloud provider id (openai, groq, openrouter, ...) when kind is "cloud". */
  cloudProvider: string;
  model: string;
  /** Base URL for a custom OpenAI-compatible cloud provider. */
  cloudBaseUrl: string;
  /** Base URL of "Your own server" (any OpenAI-compatible endpoint). */
  serverUrl: string;
  /** Model used for Command mode parsing when that purpose is overridden. */
  commandModel: string;
  overrides: Record<AiPurpose, boolean>;
}

interface AiProviderState extends GlobalAiConfig {
  apiKey: string;
  loaded: boolean;
  update: (patch: Partial<Omit<GlobalAiConfig, "overrides">>) => void;
  setApiKey: (key: string) => void;
  setOverride: (purpose: AiPurpose, enabled: boolean) => void;
}

const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

const emptyOverrides = (): Record<AiPurpose, boolean> => ({
  dictationCleanup: false,
  assistantChat: false,
  commandParsing: false,
  speechToText: false,
  spokenReplies: false,
});

function defaults(): GlobalAiConfig {
  return {
    kind: "local",
    cloudProvider: "openrouter",
    model: OVERLAY_DEFAULT_MODEL,
    cloudBaseUrl: "",
    serverUrl: "",
    commandModel: "",
    overrides: emptyOverrides(),
  };
}

function readStored(): GlobalAiConfig {
  const base = defaults();
  if (!isBrowser) return base;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<GlobalAiConfig>;
    return {
      kind:
        parsed.kind === "own-server" || parsed.kind === "cloud" || parsed.kind === "local"
          ? parsed.kind
          : base.kind,
      cloudProvider: typeof parsed.cloudProvider === "string" ? parsed.cloudProvider : base.cloudProvider,
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : base.model,
      cloudBaseUrl: typeof parsed.cloudBaseUrl === "string" ? parsed.cloudBaseUrl : "",
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
      commandModel: typeof parsed.commandModel === "string" ? parsed.commandModel : "",
      overrides: { ...emptyOverrides(), ...(parsed.overrides || {}) },
    };
  } catch {
    return base;
  }
}

function persist(config: GlobalAiConfig) {
  if (!isBrowser) return;
  const { kind, cloudProvider, model, cloudBaseUrl, serverUrl, commandModel, overrides } = config;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ kind, cloudProvider, model, cloudBaseUrl, serverUrl, commandModel, overrides })
  );
}

export function isLocalOllamaUrl(url: string | undefined | null): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url.trim());
    return (
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname) &&
      (parsed.port === "11434" || parsed.port === "")
    );
  } catch {
    return false;
  }
}

/** The per-feature settings a global choice writes. Pure, so it is unit-tested. */
export function globalToScopePatch(
  config: Pick<GlobalAiConfig, "kind" | "cloudProvider" | "model" | "cloudBaseUrl" | "serverUrl">,
  apiKey: string
): Partial<Omit<ResolvedLLMConfig, "scope">> {
  if (config.kind === "cloud") {
    return {
      mode: "providers",
      cloudMode: "byok",
      provider: config.cloudProvider,
      model: config.model,
      cloudBaseUrl: config.cloudProvider === "custom" ? config.cloudBaseUrl : "",
      ...(config.cloudProvider === "custom" ? { customApiKey: apiKey } : {}),
    };
  }
  const url =
    config.kind === "own-server" && config.serverUrl.trim()
      ? config.serverUrl.trim()
      : OVERLAY_DEFAULT_OLLAMA_URL;
  return {
    mode: "self-hosted",
    cloudMode: "byok",
    remoteUrl: url,
    model: config.model,
    disableThinking: true,
    ...(config.kind === "own-server" ? { customApiKey: apiKey } : {}),
  };
}

function applyStt(config: GlobalAiConfig): void {
  const store = useSettingsStore.getState();
  if (config.kind === "cloud" && CLOUD_STT_PROVIDERS.has(config.cloudProvider)) {
    const provider = getTranscriptionProvider(config.cloudProvider);
    const model = provider?.models?.[0]?.id;
    if (!provider || !model) return;
    store.setCloudTranscriptionForAllScopes({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: config.cloudProvider,
      cloudTranscriptionModel: model,
    });
    if (isBrowser) localStorage.setItem(STT_APPLIED_KEY, "1");
    return;
  }
  // Only undo what "use global" itself switched to the cloud; a user's own
  // speech-to-text choice is never overwritten.
  if (isBrowser && localStorage.getItem(STT_APPLIED_KEY) === "1") {
    store.setCloudTranscriptionForAllScopes({ useLocalWhisper: true, cloudTranscriptionMode: "byok" });
    localStorage.removeItem(STT_APPLIED_KEY);
  }
}

/** Write the global choice into every purpose that is not overridden. */
export function applyGlobalProvider(): void {
  const state = useAiProvider.getState();
  const patch = globalToScopePatch(state, state.apiKey);
  // The per-scope model setters switch hardware auto-select off (they model a
  // manual pick). A global write is not a manual pick, so keep the flag as is.
  const autoSelect = useSettingsStore.getState().overlayModelAutoSelect;
  for (const purpose of ["dictationCleanup", "assistantChat"] as const) {
    if (state.overrides[purpose]) continue;
    for (const scope of PURPOSE_SCOPES[purpose] ?? []) {
      setResolvedLLMConfig(scope, patch);
    }
  }
  const settings = useSettingsStore.getState();
  if (autoSelect && !settings.overlayModelAutoSelect) settings.setOverlayModelAutoSelect(true);
  if (!state.overrides.commandParsing) {
    settings.setCommandModeParser(state.kind === "cloud" ? "cloud" : "local");
  }
  if (!state.overrides.speechToText) applyStt(state);
}

export const useAiProvider = create<AiProviderState>()((set, get) => ({
  ...readStored(),
  apiKey: "",
  loaded: false,
  update: (patch) => {
    set(patch);
    persist(get());
    applyGlobalProvider();
  },
  setApiKey: (key) => {
    set({ apiKey: key });
    void window.electronAPI?.saveAiGlobalCustomKey?.(key);
    applyGlobalProvider();
  },
  setOverride: (purpose, enabled) => {
    set({ overrides: { ...get().overrides, [purpose]: enabled } });
    persist(get());
    // Turning an override off hands the purpose back to the global provider.
    if (!enabled) applyGlobalProvider();
  },
}));

/** Command mode's parser settings: the global provider unless overridden. */
export function resolveCommandParsing(
  settings = getSettings(),
  ai: GlobalAiConfig = useAiProvider.getState()
): { parser: "local" | "cloud"; model: string; localBaseUrl: string; cloudProvider: string } {
  const chat = selectResolvedLLMConfig(settings, "chatIntelligence");
  if (!ai.overrides.commandParsing) {
    return {
      parser: ai.kind === "cloud" ? "cloud" : "local",
      model: ai.model || chat.model,
      localBaseUrl:
        ai.kind === "own-server" && ai.serverUrl ? ai.serverUrl : OVERLAY_DEFAULT_OLLAMA_URL,
      cloudProvider: ai.cloudProvider,
    };
  }
  return {
    parser: settings.commandModeParser,
    model: ai.commandModel || chat.model,
    localBaseUrl: chat.remoteUrl || OVERLAY_DEFAULT_OLLAMA_URL,
    cloudProvider: chat.provider,
  };
}

/**
 * First run of this version: derive the global choice from what the user has
 * today, and mark any purpose that differs as overridden, so nothing changes.
 */
export function migrateExistingChoices(): void {
  if (!isBrowser || localStorage.getItem(MIGRATED_KEY) === "1") return;
  const settings = getSettings();
  const chat = selectResolvedLLMConfig(settings, "chatIntelligence");
  const config = defaults();

  if (chat.mode === "providers") {
    config.kind = "cloud";
    config.cloudProvider = chat.provider || config.cloudProvider;
    config.model = chat.model || config.model;
    config.cloudBaseUrl = chat.cloudBaseUrl || "";
  } else if (chat.mode === "self-hosted") {
    const url = chat.remoteUrl || OVERLAY_DEFAULT_OLLAMA_URL;
    config.kind = isLocalOllamaUrl(url) ? "local" : "own-server";
    config.serverUrl = config.kind === "own-server" ? url : "";
    config.model = chat.model || config.model;
  } else {
    config.kind = "local";
    config.model = chat.model || config.model;
  }

  const sameAsGlobal = (scope: InferenceScope) => {
    const resolved = selectResolvedLLMConfig(settings, scope);
    const wanted = globalToScopePatch(config, "");
    return (
      resolved.mode === wanted.mode &&
      resolved.model === wanted.model &&
      (wanted.mode !== "providers" || resolved.provider === wanted.provider) &&
      (wanted.mode !== "self-hosted" || (resolved.remoteUrl || "") === (wanted.remoteUrl || ""))
    );
  };
  for (const purpose of ["dictationCleanup", "assistantChat"] as const) {
    config.overrides[purpose] = !(PURPOSE_SCOPES[purpose] ?? [])
      .filter((scope) => scope !== "noteFormatting" && scope !== "dictationTranslation")
      .every(sameAsGlobal);
  }
  config.overrides.commandParsing =
    settings.commandModeParser === "cloud" && config.kind !== "cloud";
  config.overrides.speechToText = settings.transcriptionMode !== "local";
  config.overrides.spokenReplies = false;

  useAiProvider.setState(config);
  persist({ ...config });
  localStorage.setItem(MIGRATED_KEY, "1");
  logger.info("Migrated AI provider choice", { kind: config.kind, overrides: config.overrides }, "settings");
}

/** Load the secret key and migrate existing choices. Called once at startup. */
export async function initAiProvider(): Promise<void> {
  if (useAiProvider.getState().loaded) return;
  migrateExistingChoices();
  try {
    const key = await window.electronAPI?.getAiGlobalCustomKey?.();
    useAiProvider.setState({ apiKey: key || "", loaded: true });
  } catch {
    useAiProvider.setState({ loaded: true });
  }
}

/** Hardware auto-select picked a model for this PC: carry it to the global choice. */
export function applyAutoSelectedModel(model: string): void {
  const state = useAiProvider.getState();
  if (state.kind !== "local" || !model || state.model === model) return;
  state.update({ model });
}
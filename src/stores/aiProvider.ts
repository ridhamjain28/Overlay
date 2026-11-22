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
import logger from "../utils/logger";

/**
 * One AI provider and one model for every language-model task (dictation
 * cleanup, assistant chat, Command mode parsing, translation, note formatting).
 *
 * The runtime still reads the per-feature keys in settingsStore (every request
 * path, the main process and the older migrations understand those). This
 * module owns the single user-facing choice and writes it through to all of
 * them, so nothing downstream changes. Cloud API keys and the own-server key
 * stay in the main process's secure storage; nothing here logs or exposes a key.
 */

export type AiProviderKind = "local" | "own-server" | "cloud";

/** Every language-model scope the single choice drives. */
export const GLOBAL_LLM_SCOPES: readonly InferenceScope[] = [
  "dictationCleanup",
  "dictationAgent",
  "noteFormatting",
  "chatIntelligence",
  "dictationTranslation",
];

const STORAGE_KEY = "overlayAiProvider";
const MIGRATED_KEY = "overlayAiProviderMigrated";

export interface GlobalAiConfig {
  kind: AiProviderKind;
  /** Cloud provider id (openai, groq, openrouter, ...) when kind is "cloud". */
  cloudProvider: string;
  model: string;
  /** Base URL for a custom OpenAI-compatible cloud provider. */
  cloudBaseUrl: string;
  /** Base URL of "Your own server" (any OpenAI-compatible endpoint). */
  serverUrl: string;
}

interface AiProviderState extends GlobalAiConfig {
  apiKey: string;
  loaded: boolean;
  update: (patch: Partial<GlobalAiConfig>) => void;
  /** Switch the provider kind, remembering the model chosen for each kind. */
  selectKind: (kind: AiProviderKind) => void;
  setApiKey: (key: string) => void;
}

const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

function defaults(): GlobalAiConfig {
  return {
    kind: "local",
    cloudProvider: "openrouter",
    model: OVERLAY_DEFAULT_MODEL,
    cloudBaseUrl: "",
    serverUrl: "",
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
      cloudProvider:
        typeof parsed.cloudProvider === "string" ? parsed.cloudProvider : base.cloudProvider,
      model: typeof parsed.model === "string" ? parsed.model : base.model,
      cloudBaseUrl: typeof parsed.cloudBaseUrl === "string" ? parsed.cloudBaseUrl : "",
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
    };
  } catch {
    return base;
  }
}

function persist(config: GlobalAiConfig) {
  if (!isBrowser) return;
  const { kind, cloudProvider, model, cloudBaseUrl, serverUrl } = config;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ kind, cloudProvider, model, cloudBaseUrl, serverUrl })
  );
}

function readModelByKind(): Partial<Record<AiProviderKind, string>> {
  if (!isBrowser) return {};
  try {
    return JSON.parse(localStorage.getItem("overlayAiModelByKind") || "{}");
  } catch {
    return {};
  }
}

function writeModelByKind(value: Partial<Record<AiProviderKind, string>>) {
  if (isBrowser) localStorage.setItem("overlayAiModelByKind", JSON.stringify(value));
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

/** Write the single choice into every language-model scope. */
export function applyGlobalProvider(): void {
  const state = useAiProvider.getState();
  // An unfinished choice (no model yet) must not blank a working configuration.
  if (!state.model) return;
  const patch = globalToScopePatch(state, state.apiKey);
  // The per-scope model setters switch hardware auto-select off (they model a
  // manual pick). A global write is not a manual pick, so keep the flag as is.
  const autoSelect = useSettingsStore.getState().overlayModelAutoSelect;
  for (const scope of GLOBAL_LLM_SCOPES) setResolvedLLMConfig(scope, patch);
  const settings = useSettingsStore.getState();
  if (autoSelect && !settings.overlayModelAutoSelect) settings.setOverlayModelAutoSelect(true);
  settings.setCommandModeParser(state.kind === "cloud" ? "cloud" : "local");
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
  selectKind: (kind) => {
    const current = get();
    if (current.kind === kind) return;
    const byKind = readModelByKind();
    byKind[current.kind] = current.model;
    writeModelByKind(byKind);
    const remembered = byKind[kind] || (kind === "local" ? OVERLAY_DEFAULT_MODEL : "");
    get().update({ kind, model: remembered });
  },
  setApiKey: (key) => {
    set({ apiKey: key });
    void window.electronAPI?.saveAiGlobalCustomKey?.(key);
    applyGlobalProvider();
  },
}));

/** Command mode's parser settings: always the single global choice. */
export function resolveCommandParsing(
  settings = getSettings(),
  ai: GlobalAiConfig = useAiProvider.getState()
): { parser: "local" | "cloud"; model: string; localBaseUrl: string; cloudProvider: string } {
  const chat = selectResolvedLLMConfig(settings, "chatIntelligence");
  return {
    parser: ai.kind === "cloud" ? "cloud" : "local",
    model: ai.model || chat.model,
    localBaseUrl:
      ai.kind === "own-server" && ai.serverUrl ? ai.serverUrl : OVERLAY_DEFAULT_OLLAMA_URL,
    cloudProvider: ai.cloudProvider,
  };
}

/** Derive the single choice from the per-purpose settings that exist today. */
export function deriveGlobalFromScopes(
  settings = getSettings()
): Pick<GlobalAiConfig, "kind" | "cloudProvider" | "model" | "cloudBaseUrl" | "serverUrl"> {
  const config = defaults();
  // chatAgent* wins when it is set to something usable; otherwise the dictation model.
  const usable = (scope: InferenceScope) => {
    const resolved = selectResolvedLLMConfig(settings, scope);
    const ok =
      (resolved.mode === "providers" && !!resolved.model) ||
      (resolved.mode === "self-hosted" && !!resolved.model) ||
      (resolved.mode === "local" && !!resolved.model);
    return ok ? resolved : null;
  };
  const chosen = usable("chatIntelligence") ?? usable("dictationCleanup");
  if (!chosen) return config;
  if (chosen.mode === "providers") {
    config.kind = "cloud";
    config.cloudProvider = chosen.provider || config.cloudProvider;
    config.model = chosen.model;
    config.cloudBaseUrl = chosen.cloudBaseUrl || "";
  } else if (chosen.mode === "self-hosted") {
    const url = chosen.remoteUrl || OVERLAY_DEFAULT_OLLAMA_URL;
    config.kind = isLocalOllamaUrl(url) ? "local" : "own-server";
    config.serverUrl = config.kind === "own-server" ? url : "";
    config.model = chosen.model;
  } else {
    config.kind = "local";
    config.model = chosen.model;
  }
  return config;
}

/** First run of this version: collapse the per-purpose settings into one choice. */
export function migrateExistingChoices(): void {
  if (!isBrowser || localStorage.getItem(MIGRATED_KEY) === "1") return;
  const config = deriveGlobalFromScopes();
  useAiProvider.setState(config);
  persist({ ...useAiProvider.getState() });
  localStorage.setItem(MIGRATED_KEY, "1");
  applyGlobalProvider();
  logger.info("Migrated AI provider choice", { kind: config.kind }, "settings");
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

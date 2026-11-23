// Contract for window.electronAPI.overlayApps (implemented by the main process).
// The renderer only consumes it; see src/types/electron.ts for the declaration.

export type OverlayAppsScanPhase =
  "shortcuts" | "apppaths" | "startapps" | "protocols" | "matching" | "writing";

export interface OverlayAppsScanProgress {
  /** One of OverlayAppsScanPhase today; kept a string so a newer backend phase never breaks the UI. */
  phase: string;
  done: number;
  total: number;
}

export interface ScanResultApp {
  appId: string;
  name: string;
  /** True when the app has ready-made commands. */
  matched: boolean;
  actionsCount: number;
  enabled: boolean;
  source: string;
}

export interface ScanResult {
  scannedAt: string | number;
  found: number;
  withCommands: number;
  apps: ScanResultApp[];
}

export interface AppSkillActionParam {
  name: string;
  type: string;
  required: boolean;
}

export interface AppSkillActionExample {
  utterance: string;
  params: Record<string, unknown>;
}

export type AppSkillRisk = "safe" | "confirm";

export interface AppSkillAction {
  id: string;
  description: string;
  params: AppSkillActionParam[];
  how: { type: string; template: string };
  examples: AppSkillActionExample[];
  risk: AppSkillRisk;
  /** Missing means enabled. */
  enabled?: boolean;
}

export interface AppSkill {
  appId: string;
  name: string;
  aliases: string[];
  enabled: boolean;
  actions: AppSkillAction[];
  kind?: string;
  source?: string;
  target?: string;
  aumid?: string;
  protocols?: string[];
}

export interface Learned {
  id: string;
  utterance: string;
  appId: string;
  actionId: string;
  params: Record<string, unknown>;
  plan: unknown;
  source: string;
  timestamp: string | number;
}

export interface CustomSkillsGetResult {
  text: string;
  path: string;
  errors: string[];
}

export interface CustomSkillsSaveResult {
  ok: boolean;
  errors: string[];
}

export interface CustomSkillsValidateResult {
  ok: boolean;
  errors: string[];
}

export interface OverlayAppsApi {
  scan(): Promise<ScanResult>;
  /** Returns an unsubscribe function. */
  onScanProgress(cb: (progress: OverlayAppsScanProgress) => void): () => void;
  list(): Promise<AppSkill[]>;
  setEnabled(args: { appId: string; actionId?: string; enabled: boolean }): Promise<void>;
  test(args: {
    appId: string;
    actionId: string;
    params: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }>;
  learnedList(): Promise<Learned[]>;
  learnedDelete(id: string): Promise<void>;
  getSummary(): Promise<ScanResult | null>;
  customGet(): Promise<CustomSkillsGetResult>;
  customSave(text: string): Promise<CustomSkillsSaveResult>;
  customValidate(text: string): Promise<CustomSkillsValidateResult>;
  customOpenFile(): Promise<void>;
}

export type McpServerStatus = "connected" | "connecting" | "disconnected" | "needsAuth" | "error";

export interface McpServerInfo {
  name: string;
  type: "stdio" | "remote";
  command?: string;
  args?: string[];
  url?: string;
  status: McpServerStatus;
  error?: string | null;
  toolsCount: number;
  hasEnvSecrets?: boolean;
}

export interface McpToolAnnotation {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  [key: string]: unknown;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: McpToolAnnotation;
  enabled?: boolean;
}

export interface McpGalleryServer {
  id: string;
  name: string;
  description: string;
  type: "stdio" | "remote";
  config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  needsAuth: boolean;
  authType?: string;
  notice?: string;
  hasEnvSecrets?: boolean;
  verifiedOn?: string;
  verifiedUrl?: string;
}

export interface McpDiscoveredEnvDetail {
  key: string;
  maskedValue: string;
  isSecret: boolean;
  hasValue: boolean;
}

export interface McpDiscoveredServer {
  source: string;
  sourceKey: string;
  filePath: string;
  serverName: string;
  config: Record<string, unknown>;
  hasEnvSecrets: boolean;
  envKeys: string[];
  envDetails?: McpDiscoveredEnvDetail[];
}

export interface McpSavedPermission {
  key: string;
  type: string;
  server?: string;
  tool?: string;
  action?: string;
  allowedAt: number;
}

export interface McpConfigGetResult {
  text: string;
  path: string;
  servers: Record<string, unknown>;
  errors: string[];
}

export interface McpConfigSaveResult {
  ok: boolean;
  errors: string[];
}

export interface McpStatusEvent {
  name: string;
  status: McpServerStatus;
  error?: string | null;
  toolsCount: number;
  connectedAt?: number;
}

export interface OverlayMcpApi {
  list: () => Promise<McpServerInfo[]>;
  add: (name: string, cfg: Record<string, unknown>) => Promise<McpConfigSaveResult>;
  remove: (name: string) => Promise<McpConfigSaveResult>;
  connect: (name: string) => Promise<{ ok: boolean; error?: string }>;
  disconnect: (name: string) => Promise<{ ok: boolean }>;
  auth: (name: string) => Promise<{ ok: boolean; error?: string }>;
  tools: (name: string) => Promise<McpToolInfo[]>;
  setToolEnabled: (name: string, tool: string, on: boolean) => Promise<{ ok: boolean }>;
  configGet: () => Promise<McpConfigGetResult>;
  configSave: (text: string) => Promise<McpConfigSaveResult>;
  test: (name: string) => Promise<{ ok: boolean; tools?: McpToolInfo[]; error?: string }>;
  gallery: () => Promise<McpGalleryServer[]>;
  importDiscover: () => Promise<McpDiscoveredServer[]>;
  importServers: (
    selected: Array<{ serverName: string; config: Record<string, unknown> }>,
    envImportChoices?: Record<string, Record<string, boolean>>,
    importEnvValues?: boolean
  ) => Promise<{ ok: boolean; imported: number; errors: string[] }>;
  permissionsList: () => Promise<McpSavedPermission[]>;
  permissionsRevoke: (key: string) => Promise<{ ok: boolean }>;
  onStatus: (callback: (payload: McpStatusEvent) => void) => () => void;
}

// MCP Client Manager
// Connects stdio and remote MCP servers, caches tools to disk, performs lazy start,
// handles auto-reconnect, and maintains status.
// NEVER logs secrets or tokens.

const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");

const { McpConfigStore } = require("./mcpConfig");
const { saveServerCache, readServerCache, readAllCachedTools, removeServerCache } = require("./mcpCache");
const { McpAuthStore } = require("./mcpAuth");
const { ToolIndex } = require("./toolIndex");

const LOG_FILE = "mcp.log";
const DISABLED_TOOLS_FILE = "mcp-disabled-tools.json";
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;

function sanitizeLogMessage(msg) {
  if (typeof msg !== "string") msg = String(msg ?? "");
  // Redact bearer/basic tokens, URL credentials, query params, well-known keys, and key=value secrets
  return msg
    .replace(/(\b(?:bearer|basic)\s+)[a-zA-Z0-9_\-.~+/=]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)([^:\s/]+):([^@\s/]+)@/gi, "$1$2:[REDACTED]@")
    .replace(/([?&](?:token|key|api_key|apiKey|password|secret|auth)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bsk-ant-[a-zA-Z0-9_-]{10,}\b/g, "sk-ant-[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "sk-[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "AIza[REDACTED]")
    .replace(/\bgh[pousr][_-][A-Za-z0-9_]{30,}\b/g, "gh[REDACTED]")
    .replace(/\bhf_[A-Za-z0-9]{30,}\b/g, "hf_[REDACTED]")
    .replace(/\btvly-[a-zA-Z0-9_-]{16,}\b/g, "tvly-[REDACTED]")
    .replace(/\boc_[a-zA-Z0-9_-]{16,}\b/g, "oc-[REDACTED]")
    .replace(
      /(["']?(?:[a-z0-9_-]*[_-])?(?:token|key|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)([^"',\s}[\]]+)(["']?)/gi,
      (match, p1, p2, p3) => (/^\[REDACTED\]$/i.test(p2) ? match : `${p1}[REDACTED]${p3}`)
    );
}

class McpManager {
  constructor(options = {}) {
    this.appDataDir = options.appDataDir;
    this.userDataDir = options.userDataDir || ".";
    this.fsImpl = options.fsImpl || fs;
    this.openBrowser = options.openBrowser;
    this.safeStorage = options.safeStorage;

    this.configStore = options.configStore || new McpConfigStore({
      appDataDir: this.appDataDir,
      fsImpl: this.fsImpl,
    });
    this.authStore = options.authStore || new McpAuthStore(this.userDataDir, {
      safeStorage: this.safeStorage,
      fsImpl: this.fsImpl,
    });

    this.clients = new Map(); // serverName -> Client
    this.transports = new Map(); // serverName -> Transport
    this.serverStatuses = new Map(); // serverName -> { status, error, toolsCount, connectedAt }
    this.reconnectTimers = new Map();
    this.reconnectBackoff = new Map();
    this.connectingPromises = new Map(); // serverName -> Promise<Client>
    this.statusListeners = new Set();
    this.disabledTools = new Set();
    this.shuttingDown = false;
    this.toolCallTimeoutMs =
      Number.isFinite(Number(options.toolCallTimeoutMs)) && Number(options.toolCallTimeoutMs) > 0
        ? Number(options.toolCallTimeoutMs)
        : DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this._unsubscribeConfig = null;

    this.toolIndex = new ToolIndex();
    this.loadDisabledTools();
  }

  log(level, serverName, message, extra = {}) {
    try {
      const logDir = path.join(this.userDataDir, "logs");
      this.fsImpl.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, LOG_FILE);
      const timestamp = new Date().toISOString();
      const safeExtra = sanitizeLogMessage(JSON.stringify(extra));
      const line = `[${timestamp}] [${level.toUpperCase()}] [${serverName || "core"}] ${sanitizeLogMessage(message)} ${safeExtra !== "{}" ? safeExtra : ""}\n`;
      this.fsImpl.appendFileSync(logPath, line, "utf-8");
    } catch {}
  }

  loadDisabledTools() {
    try {
      const p = path.join(this.userDataDir, DISABLED_TOOLS_FILE);
      if (this.fsImpl.existsSync(p)) {
        const raw = this.fsImpl.readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.disabledTools = new Set(parsed);
        }
      }
    } catch {}
  }

  saveDisabledTools() {
    try {
      const p = path.join(this.userDataDir, DISABLED_TOOLS_FILE);
      this.fsImpl.mkdirSync(path.dirname(p), { recursive: true });
      this.fsImpl.writeFileSync(p, JSON.stringify(Array.from(this.disabledTools), null, 2), "utf-8");
    } catch {}
  }

  isToolEnabled(serverName, toolName) {
    return !this.disabledTools.has(`${serverName}:${toolName}`);
  }

  setToolEnabled(serverName, toolName, enabled) {
    const key = `${serverName}:${toolName}`;
    if (enabled) {
      this.disabledTools.delete(key);
    } else {
      this.disabledTools.add(key);
    }
    this.saveDisabledTools();
  }

  setStatus(serverName, status, error = null, toolsCount = undefined) {
    const existing = this.serverStatuses.get(serverName) || {};
    const nextToolsCount =
      typeof toolsCount === "number" && Number.isFinite(toolsCount)
        ? toolsCount
        : existing.toolsCount ?? 0;
    const connectedAt =
      status === "connected"
        ? Date.now()
        : status === "disconnected" || status === "error" || status === "needsAuth"
          ? null
          : existing.connectedAt ?? null;
    const updated = {
      name: serverName,
      status,
      error: error ? sanitizeLogMessage(String(error)) : null,
      toolsCount: nextToolsCount,
      connectedAt,
    };
    this.serverStatuses.set(serverName, updated);
    this.notifyStatus(updated);
  }

  onStatus(callback) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  notifyStatus(statusObj) {
    for (const listener of this.statusListeners) {
      try {
        listener(statusObj);
      } catch {}
    }
  }

  async init() {
    this.shuttingDown = false;
    this.configStore.ensureConfigFile();
    this.configStore.startWatch();
    if (this._unsubscribeConfig) {
      this._unsubscribeConfig();
    }
    this._unsubscribeConfig = this.configStore.onChange((servers) => {
      this.handleConfigChange(servers);
    });

    // Build tool index from disk cache at startup (NO stdio processes spawned)
    this.refreshIndexFromDisk();

    // Check configured servers and set initial status
    const config = this.configStore.read();
    for (const name of Object.keys(config.servers || {})) {
      const cached = readServerCache(name, { appDataDir: this.appDataDir, fsImpl: this.fsImpl });
      this.setStatus(name, "disconnected", null, cached.tools.length);
    }

    this.log("info", "manager", "Initialized MCP manager with disk cache index");
  }

  refreshIndexFromDisk() {
    const tools = readAllCachedTools({ appDataDir: this.appDataDir, fsImpl: this.fsImpl });
    this.toolIndex.build(tools);
    return tools;
  }

  handleConfigChange(servers) {
    const activeServers = servers && typeof servers === "object" ? servers : {};
    const knownNames = new Set([
      ...this.clients.keys(),
      ...this.serverStatuses.keys(),
      ...this.reconnectTimers.keys(),
    ]);

    // Reconcile removed servers (including disconnected, errored, or pending-reconnect ones)
    for (const name of knownNames) {
      if (!Object.prototype.hasOwnProperty.call(activeServers, name)) {
        this.disconnect(name, { removeStatus: true }).catch(() => {});
        this.serverStatuses.delete(name);
        this.reconnectBackoff.delete(name);
        removeServerCache(name, { appDataDir: this.appDataDir, fsImpl: this.fsImpl });
        try {
          const riskPolicy = require("../commandMode/riskPolicy");
          riskPolicy.revokeServerPermissions(this.userDataDir, name, this.fsImpl);
        } catch {}
        try {
          this.authStore.removeTokens(name);
          this.authStore.removeEnvSecrets(name);
        } catch {}
      }
    }
    this.refreshIndexFromDisk();
  }

  listPermissions() {
    try {
      const riskPolicy = require("../commandMode/riskPolicy");
      return riskPolicy.listSavedPermissions(this.userDataDir, this.fsImpl);
    } catch {
      return [];
    }
  }

  revokePermission(key) {
    try {
      const riskPolicy = require("../commandMode/riskPolicy");
      return riskPolicy.revokePermission(this.userDataDir, key, this.fsImpl);
    } catch {
      return false;
    }
  }

  async connect(serverName) {
    if (this.shuttingDown) {
      throw new Error("MCP manager is shutting down");
    }

    const config = this.configStore.read();
    const serverCfg = config.servers?.[serverName];
    if (!serverCfg) {
      throw new Error(`Server "${serverName}" not found in config`);
    }

    if (this.clients.has(serverName)) {
      return this.clients.get(serverName);
    }

    if (this.connectingPromises.has(serverName)) {
      return this.connectingPromises.get(serverName);
    }

    if (this.reconnectTimers.has(serverName)) {
      clearTimeout(this.reconnectTimers.get(serverName));
      this.reconnectTimers.delete(serverName);
    }

    const connectPromise = this._connectInternal(serverName, serverCfg).finally(() => {
      if (this.connectingPromises.get(serverName) === connectPromise) {
        this.connectingPromises.delete(serverName);
      }
    });
    this.connectingPromises.set(serverName, connectPromise);
    return connectPromise;
  }

  async _connectInternal(serverName, serverCfg) {
    this.setStatus(serverName, "connecting");
    this.log("info", serverName, `Connecting to server (${serverCfg.command ? "stdio" : "remote"})`);

    let transport;
    let client;

    try {
      if (serverCfg.command) {
        // stdio server: spawn with no shell, merge non-secret env + decrypted safeStorage secrets
        const storedSecrets =
          typeof this.authStore?.getEnvSecrets === "function"
            ? this.authStore.getEnvSecrets(serverName)
            : {};
        const configEnv = {};
        for (const [k, v] of Object.entries(serverCfg.env || {})) {
          if (v === "__OVERLAY_SECRET_REF__" || v === "••••••••") {
            if (Object.prototype.hasOwnProperty.call(storedSecrets, k)) {
              configEnv[k] = storedSecrets[k];
            }
          } else {
            configEnv[k] = v;
          }
        }
        const mergedEnv = {
          ...process.env,
          ...configEnv,
        };
        // Clean out sensitive parent env variables if needed, never log them
        transport = new StdioClientTransport({
          command: serverCfg.command,
          args: serverCfg.args || [],
          env: mergedEnv,
          shell: false,
        });
      } else if (serverCfg.url) {
        // remote server: check auth tokens
        const token = this.authStore.getTokens(serverName);
        const headers = { ...(serverCfg.headers || {}) };
        if (token?.accessToken) {
          headers["Authorization"] = `Bearer ${token.accessToken}`;
        }

        const parsedUrl = new URL(serverCfg.url);
        const host = parsedUrl.hostname.toLowerCase();
        const isNotion = host === "notion.com" || host.endsWith(".notion.com");
        if (isNotion) {
          // Notion: strictly Streamable HTTP, no /sse fallback
          transport = new StreamableHTTPClientTransport(parsedUrl, {
            requestInit: { headers },
          });
        } else {
          try {
            // First attempt Streamable HTTP
            transport = new StreamableHTTPClientTransport(parsedUrl, {
              requestInit: { headers },
            });
          } catch {
            // Fall back to SSE
            transport = new SSEClientTransport(parsedUrl, {
              eventSourceInit: { headers },
              requestInit: { headers },
            });
          }
        }
      }

      client = new Client({ name: "Overlay", version: "0.2.0" }, { capabilities: { tools: {} } });

      // Handle server list changes
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.log("info", serverName, "Received tools/list_changed notification, refreshing cache");
        await this.refreshTools(serverName);
      });

      await client.connect(transport);

      if (this.shuttingDown) {
        try {
          if (transport?.close) await transport.close();
        } catch {}
        try {
          if (client?.close) await client.close();
        } catch {}
        throw new Error("MCP manager is shutting down");
      }

      this.clients.set(serverName, client);
      this.transports.set(serverName, transport);
      this.reconnectBackoff.set(serverName, 1000);

      // Refresh and cache tools immediately upon connecting
      const tools = await this.refreshTools(serverName);

      this.setStatus(serverName, "connected", null, tools.length);
      this.log("info", serverName, `Connected successfully. Discovered ${tools.length} tools.`);

      return client;
    } catch (err) {
      try {
        if (transport?.close) await transport.close();
      } catch {}
      try {
        if (client?.close) await client.close();
      } catch {}

      const safeMessage = sanitizeLogMessage(err?.message || String(err));
      this.log("error", serverName, `Connection failed: ${safeMessage}`);
      if (!this.shuttingDown) {
        if (err?.status === 401 || safeMessage.includes("401") || safeMessage.includes("Unauthorized")) {
          this.setStatus(serverName, "needsAuth", safeMessage);
        } else {
          this.setStatus(serverName, "error", safeMessage);
          this.scheduleReconnect(serverName);
        }
      }
      const sanitizedError = new Error(safeMessage);
      if (err?.status !== undefined) sanitizedError.status = err.status;
      if (err?.code !== undefined) sanitizedError.code = err.code;
      throw sanitizedError;
    }
  }

  async refreshTools(serverName) {
    const client = this.clients.get(serverName);
    if (!client) return [];

    try {
      const res = await client.listTools();
      const tools = res?.tools || [];

      // Best effort instructions
      let instructions = "";
      try {
        if (typeof client.getInstructions === "function") {
          instructions = await client.getInstructions();
        }
      } catch {}

      saveServerCache(
        serverName,
        { tools, instructions },
        { appDataDir: this.appDataDir, fsImpl: this.fsImpl }
      );

      this.refreshIndexFromDisk();
      return tools;
    } catch (err) {
      this.log("warn", serverName, `Failed to list tools: ${err.message}`);
      return [];
    }
  }

  scheduleReconnect(serverName) {
    if (this.shuttingDown || this.reconnectTimers.has(serverName)) return;
    const currentBackoff = this.reconnectBackoff.get(serverName) || 1000;
    const nextBackoff = Math.min(currentBackoff * 2, 30000);
    this.reconnectBackoff.set(serverName, nextBackoff);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(serverName);
      if (this.shuttingDown) return;
      const config = this.configStore.read();
      if (config.servers?.[serverName]) {
        this.log("info", serverName, `Attempting auto-reconnect (backoff: ${currentBackoff}ms)`);
        try {
          await this.connect(serverName);
        } catch {}
      }
    }, currentBackoff);
    timer.unref?.();

    this.reconnectTimers.set(serverName, timer);
  }

  async disconnect(serverName, options = {}) {
    if (this.reconnectTimers.has(serverName)) {
      clearTimeout(this.reconnectTimers.get(serverName));
      this.reconnectTimers.delete(serverName);
    }
    this.reconnectBackoff.delete(serverName);

    const transport = this.transports.get(serverName);
    const client = this.clients.get(serverName);

    this.clients.delete(serverName);
    this.transports.delete(serverName);

    try {
      if (transport?.close) await transport.close();
    } catch {}
    try {
      if (client?.close) await client.close();
    } catch {}

    if (options.removeStatus) {
      this.serverStatuses.delete(serverName);
    } else {
      const cached = readServerCache(serverName, { appDataDir: this.appDataDir, fsImpl: this.fsImpl });
      this.setStatus(serverName, "disconnected", null, cached.tools.length);
    }
    this.log("info", serverName, "Disconnected");
  }

  // Lazily connects stdio or remote server only when a tool on it is called
  async ensureConnected(serverName) {
    if (this.clients.has(serverName)) {
      return this.clients.get(serverName);
    }
    return this.connect(serverName);
  }

  async listToolsForServer(serverName) {
    if (this.clients.has(serverName)) {
      return this.refreshTools(serverName);
    }
    // Return from disk cache if not connected
    const cached = readServerCache(serverName, { appDataDir: this.appDataDir, fsImpl: this.fsImpl });
    return cached.tools;
  }

  async callTool(serverName, toolName, args = {}, options = {}) {
    if (!this.isToolEnabled(serverName, toolName)) {
      throw new Error(`Tool "${toolName}" on server "${serverName}" is disabled`);
    }

    this.log("info", serverName, `Calling tool "${toolName}"`, { hasArgs: Boolean(args) });
    const client = await this.ensureConnected(serverName);
    const rawTimeout = options?.timeoutMs ?? this.toolCallTimeoutMs;
    const timeoutMs = Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0 ? Number(rawTimeout) : 0;

    let timer = null;
    try {
      const callPromise = client.callTool(
        {
          name: toolName,
          arguments: args,
        },
        undefined,
        timeoutMs > 0 ? { timeout: timeoutMs } : undefined
      );
      const response =
        timeoutMs > 0
          ? await Promise.race([
              callPromise,
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  const timeoutErr = new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
                  timeoutErr.code = "TOOL_TIMEOUT";
                  reject(timeoutErr);
                }, timeoutMs);
              }),
            ])
          : await callPromise;

      this.log("info", serverName, `Tool "${toolName}" completed successfully`);
      return response;
    } catch (err) {
      const safeMessage = sanitizeLogMessage(err?.message || String(err));
      this.log("error", serverName, `Tool "${toolName}" failed: ${safeMessage}`);
      const sanitizedError = new Error(safeMessage);
      if (err?.code !== undefined) sanitizedError.code = err.code;
      if (err?.status !== undefined) sanitizedError.status = err.status;
      throw sanitizedError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  listServers() {
    const config = this.configStore.read();
    const result = [];
    for (const [name, cfg] of Object.entries(config.servers || {})) {
      const status = this.serverStatuses.get(name) || {
        name,
        status: "disconnected",
        toolsCount: 0,
      };
      result.push({
        name,
        type: cfg.command ? "stdio" : "remote",
        command: cfg.command,
        args: cfg.args,
        url: cfg.url,
        status: status.status,
        error: status.error,
        toolsCount: status.toolsCount,
        hasEnvSecrets: Boolean(cfg.env && Object.keys(cfg.env).length),
      });
    }
    return result;
  }

  pickTopKTools(utterance, k = 8) {
    return this.toolIndex.pickTopK(utterance, {
      k,
      disabledTools: this.disabledTools,
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this._unsubscribeConfig) {
      this._unsubscribeConfig();
      this._unsubscribeConfig = null;
    }
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.connectingPromises.clear();

    for (const name of Array.from(this.clients.keys())) {
      await this.disconnect(name).catch(() => {});
    }
    this.configStore.stopWatch();
  }
}

module.exports = {
  McpManager,
  sanitizeLogMessage,
};

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

const { McpConfigStore, getMcpConfigPath } = require("./mcpConfig");
const { saveServerCache, readServerCache, readAllCachedTools, removeServerCache } = require("./mcpCache");
const { McpAuthStore } = require("./mcpAuth");
const { ToolIndex } = require("./toolIndex");

const LOG_FILE = "mcp.log";
const DISABLED_TOOLS_FILE = "mcp-disabled-tools.json";

function sanitizeLogMessage(msg) {
  if (typeof msg !== "string") msg = String(msg);
  // Redact bearer tokens, api keys, passwords
  return msg
    .replace(/(bearer\s+)[a-zA-Z0-9_.-]+/gi, "$1[REDACTED]")
    .replace(/(token|key|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1$2[REDACTED]");
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
    this.statusListeners = new Set();
    this.disabledTools = new Set();

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

  setStatus(serverName, status, error = null, toolsCount = 0) {
    const existing = this.serverStatuses.get(serverName) || {};
    const updated = {
      name: serverName,
      status,
      error: error ? String(error) : null,
      toolsCount: toolsCount || existing.toolsCount || 0,
      connectedAt: status === "connected" ? Date.now() : existing.connectedAt,
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
    this.configStore.ensureConfigFile();
    this.configStore.startWatch();
    this.configStore.onChange((servers) => {
      this.handleConfigChange(servers);
    });

    // Build tool index from disk cache at startup (NO stdio processes spawned)
    this.refreshIndexFromDisk();

    // Check configured servers and set initial status
    const config = this.configStore.read();
    for (const [name, cfg] of Object.entries(config.servers || {})) {
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
    // Reconcile removed servers
    for (const name of this.clients.keys()) {
      if (!servers[name]) {
        this.disconnect(name).catch(() => {});
        removeServerCache(name, { appDataDir: this.appDataDir, fsImpl: this.fsImpl });
      }
    }
    this.refreshIndexFromDisk();
  }

  async connect(serverName) {
    const config = this.configStore.read();
    const serverCfg = config.servers?.[serverName];
    if (!serverCfg) {
      throw new Error(`Server "${serverName}" not found in config`);
    }

    if (this.clients.has(serverName)) {
      return this.clients.get(serverName);
    }

    this.setStatus(serverName, "connecting");
    this.log("info", serverName, `Connecting to server (${serverCfg.command ? "stdio" : "remote"})`);

    let transport;
    let client;

    try {
      if (serverCfg.command) {
        // stdio server: spawn with no shell, env merged
        const mergedEnv = {
          ...process.env,
          ...(serverCfg.env || {}),
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

        try {
          // First attempt Streamable HTTP
          transport = new StreamableHTTPClientTransport(new URL(serverCfg.url), {
            requestInit: { headers },
          });
        } catch {
          // Fall back to SSE
          transport = new SSEClientTransport(new URL(serverCfg.url), {
            eventSourceInit: { headers },
            requestInit: { headers },
          });
        }
      }

      client = new Client({ name: "Overlay", version: "0.2.0" }, { capabilities: { tools: {} } });

      // Handle server list changes
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.log("info", serverName, "Received tools/list_changed notification, refreshing cache");
        await this.refreshTools(serverName);
      });

      await client.connect(transport);

      this.clients.set(serverName, client);
      this.transports.set(serverName, transport);
      this.reconnectBackoff.set(serverName, 1000);

      // Refresh and cache tools immediately upon connecting
      const tools = await this.refreshTools(serverName);

      this.setStatus(serverName, "connected", null, tools.length);
      this.log("info", serverName, `Connected successfully. Discovered ${tools.length} tools.`);

      return client;
    } catch (err) {
      this.log("error", serverName, `Connection failed: ${err.message}`);
      if (err.status === 401 || String(err.message).includes("401") || String(err.message).includes("Unauthorized")) {
        this.setStatus(serverName, "needsAuth", err.message);
      } else {
        this.setStatus(serverName, "error", err.message);
        this.scheduleReconnect(serverName);
      }
      throw err;
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
    if (this.reconnectTimers.has(serverName)) return;
    const currentBackoff = this.reconnectBackoff.get(serverName) || 1000;
    const nextBackoff = Math.min(currentBackoff * 2, 30000);
    this.reconnectBackoff.set(serverName, nextBackoff);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(serverName);
      const config = this.configStore.read();
      if (config.servers?.[serverName]) {
        this.log("info", serverName, `Attempting auto-reconnect (backoff: ${currentBackoff}ms)`);
        try {
          await this.connect(serverName);
        } catch {}
      }
    }, currentBackoff);

    this.reconnectTimers.set(serverName, timer);
  }

  async disconnect(serverName) {
    if (this.reconnectTimers.has(serverName)) {
      clearTimeout(this.reconnectTimers.get(serverName));
      this.reconnectTimers.delete(serverName);
    }

    const transport = this.transports.get(serverName);
    const client = this.clients.get(serverName);

    this.clients.delete(serverName);
    this.transports.delete(serverName);

    try {
      if (transport?.close) await transport.close();
      if (client?.close) await client.close();
    } catch {}

    const cached = readServerCache(serverName, { appDataDir: this.appDataDir, fsImpl: this.fsImpl });
    this.setStatus(serverName, "disconnected", null, cached.tools.length);
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

  async callTool(serverName, toolName, args = {}) {
    this.log("info", serverName, `Calling tool "${toolName}"`, { hasArgs: Boolean(args) });
    const client = await this.ensureConnected(serverName);

    // Call tool via MCP SDK client
    const response = await client.callTool({
      name: toolName,
      arguments: args,
    });

    this.log("info", serverName, `Tool "${toolName}" completed successfully`);
    return response;
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
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

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

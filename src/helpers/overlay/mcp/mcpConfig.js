// Manages %APPDATA%\Overlay\mcp.json in the standard Claude-Desktop shape:
// {
//   "mcpServers": {
//     "<name>": { "command": "...", "args": [...], "env": { ... } } |
//               { "url": "...", "headers": { ... } }
//   }
// }

const fs = require("fs");
const path = require("path");

function getMcpConfigDir(appDataDir) {
  if (appDataDir) return path.join(appDataDir, "Overlay");
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "Overlay");
  const home = process.env.USERPROFILE || process.env.HOME || ".";
  return path.join(home, ".overlay");
}

function getMcpConfigPath(appDataDir) {
  return path.join(getMcpConfigDir(appDataDir), "mcp.json");
}

function validateConfig(configOrText) {
  const errors = [];
  let parsed = configOrText;
  if (typeof configOrText === "string") {
    try {
      parsed = JSON.parse(configOrText);
    } catch (e) {
      return { ok: false, errors: [`Invalid JSON syntax: ${e.message}`], servers: {} };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["Root of mcp.json must be an object with an 'mcpServers' map"], servers: {} };
  }

  const mcpServers = parsed.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return { ok: false, errors: ["Configuration must contain an 'mcpServers' object"], servers: {} };
  }

  const validServers = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    const trimmedName = String(name || "").trim();
    if (!trimmedName || !/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      errors.push(`Server name "${name}" is invalid: must be alphanumeric with dashes or underscores`);
      continue;
    }
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      errors.push(`Server "${trimmedName}" must be an object`);
      continue;
    }

    // Must be either stdio (command) or remote (url)
    const hasCommand = typeof server.command === "string" && server.command.trim().length > 0;
    const hasUrl = typeof server.url === "string" && server.url.trim().length > 0;

    if (!hasCommand && !hasUrl) {
      errors.push(`Server "${trimmedName}" must specify either a "command" (stdio) or "url" (remote)`);
      continue;
    }

    if (hasCommand) {
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      const env = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? { ...server.env } : undefined;
      validServers[trimmedName] = {
        command: server.command.trim(),
        args,
        ...(env ? { env } : {}),
      };
    } else if (hasUrl) {
      let validUrl;
      try {
        validUrl = new URL(server.url);
      } catch {
        errors.push(`Server "${trimmedName}" has invalid URL "${server.url}"`);
        continue;
      }
      if (validUrl.protocol !== "https:" && validUrl.protocol !== "http:") {
        errors.push(`Server "${trimmedName}" URL must use http or https`);
        continue;
      }
      const headers = server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? { ...server.headers } : undefined;
      validServers[trimmedName] = {
        url: validUrl.toString(),
        ...(headers ? { headers } : {}),
      };
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    servers: validServers,
  };
}

class McpConfigStore {
  constructor(options = {}) {
    this.appDataDir = options.appDataDir;
    this.fsImpl = options.fsImpl || fs;
    this.filePath = options.filePath || getMcpConfigPath(this.appDataDir);
    this.listeners = new Set();
    this.watcher = null;
    this._debounceTimer = null;
  }

  ensureConfigFile() {
    try {
      const dir = path.dirname(this.filePath);
      if (!this.fsImpl.existsSync(dir)) {
        this.fsImpl.mkdirSync(dir, { recursive: true });
      }
      if (!this.fsImpl.existsSync(this.filePath)) {
        const initial = { mcpServers: {} };
        this.fsImpl.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), "utf-8");
      }
    } catch {
      // ignore
    }
  }

  read() {
    this.ensureConfigFile();
    try {
      const raw = this.fsImpl.readFileSync(this.filePath, "utf-8");
      const validation = validateConfig(raw);
      return {
        text: raw,
        path: this.filePath,
        servers: validation.servers,
        errors: validation.errors,
      };
    } catch (e) {
      return {
        text: '{\n  "mcpServers": {}\n}',
        path: this.filePath,
        servers: {},
        errors: [`Cannot read config: ${e.message}`],
      };
    }
  }

  save(textOrObj) {
    const text = typeof textOrObj === "string" ? textOrObj : JSON.stringify(textOrObj, null, 2);
    const validation = validateConfig(text);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    try {
      this.ensureConfigFile();
      this.fsImpl.writeFileSync(this.filePath, text, "utf-8");
      this.notify(validation.servers);
      return { ok: true, errors: [] };
    } catch (e) {
      return { ok: false, errors: [`Failed to save config: ${e.message}`] };
    }
  }

  addServer(name, serverConfig) {
    const current = this.read();
    const updated = {
      mcpServers: {
        ...(current.servers || {}),
        [name]: serverConfig,
      },
    };
    return this.save(updated);
  }

  removeServer(name) {
    const current = this.read();
    const servers = { ...(current.servers || {}) };
    delete servers[name];
    return this.save({ mcpServers: servers });
  }

  startWatch() {
    if (this.watcher) return;
    this.ensureConfigFile();
    try {
      this.watcher = this.fsImpl.watch(this.filePath, () => {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          const current = this.read();
          this.notify(current.servers);
        }, 200);
      });
      if (this.watcher && typeof this.watcher.on === "function") {
        this.watcher.on("error", () => {});
      }
    } catch {
      // Watch might not be supported in some test envs
    }
  }

  stopWatch() {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
    clearTimeout(this._debounceTimer);
  }

  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(servers) {
    for (const listener of this.listeners) {
      try {
        listener(servers);
      } catch {}
    }
  }
}

module.exports = {
  getMcpConfigDir,
  getMcpConfigPath,
  validateConfig,
  McpConfigStore,
};

// Manages %APPDATA%\Overlay\mcp.json in the standard Claude-Desktop shape:
// {
//   "mcpServers": {
//     "<name>": { "command": "...", "args": [...], "env": { ... } } |
//               { "url": "...", "headers": { ... } }
//   }
// }

const fs = require("fs");
const path = require("path");
const { ENV_SECRET_REF, MASKED_ENV_VALUE } = require("./mcpAuth");

function maskEnvObject(envObj) {
  if (!envObj || typeof envObj !== "object" || Array.isArray(envObj)) return undefined;
  const masked = {};
  for (const [k, v] of Object.entries(envObj)) {
    masked[k] = v ? MASKED_ENV_VALUE : "";
  }
  return masked;
}

function maskServersMap(servers) {
  const out = {};
  for (const [name, cfg] of Object.entries(servers || {})) {
    if (!cfg || typeof cfg !== "object") continue;
    const copy = { ...cfg };
    if (copy.env) {
      copy.env = maskEnvObject(copy.env);
    }
    out[name] = copy;
  }
  return out;
}

function hasStdioConfigChanged(prevServers = {}, nextServers = {}) {
  for (const [name, nextCfg] of Object.entries(nextServers || {})) {
    if (!nextCfg || !nextCfg.command) continue;
    const prevCfg = prevServers[name];
    if (!prevCfg || !prevCfg.command) {
      return { changed: true, serverName: name, reason: "added" };
    }
    if (prevCfg.command !== nextCfg.command) {
      return { changed: true, serverName: name, reason: "command" };
    }
    if (JSON.stringify(prevCfg.args || []) !== JSON.stringify(nextCfg.args || [])) {
      return { changed: true, serverName: name, reason: "args" };
    }
    const prevEnv = prevCfg.env || {};
    const nextEnv = nextCfg.env || {};
    const prevKeys = Object.keys(prevEnv).sort();
    const nextKeys = Object.keys(nextEnv).sort();
    if (JSON.stringify(prevKeys) !== JSON.stringify(nextKeys)) {
      return { changed: true, serverName: name, reason: "env" };
    }
    for (const k of nextKeys) {
      const nv = String(nextEnv[k] ?? "");
      const pv = String(prevEnv[k] ?? "");
      // Masked placeholder preserves existing ref/value without triggering value change
      if (nv === MASKED_ENV_VALUE && pv) continue;
      if (nv !== pv) {
        return { changed: true, serverName: name, reason: "env" };
      }
    }
  }
  return { changed: false };
}

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

      // No unpinned npx -y: require exact versions
      if (server.command.trim() === "npx") {
        for (const arg of args) {
          if (arg.startsWith("-")) continue;
          if (arg.startsWith("@") || /^[a-z0-9_-]+/i.test(arg)) {
            const atCount = (arg.match(/@/g) || []).length;
            const hasVersion = arg.startsWith("@") ? atCount >= 2 : atCount >= 1;
            if (!hasVersion) {
              errors.push(
                `Server "${trimmedName}" uses unpinned npx package "${arg}". Exact version is required (e.g. ${arg}@1.0.0).`
              );
            }
            break;
          }
        }
      }

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

  readMasked() {
    const raw = this.read();
    const maskedServers = maskServersMap(raw.servers);
    return {
      text: JSON.stringify({ mcpServers: maskedServers }, null, 2),
      path: raw.path,
      servers: maskedServers,
      errors: raw.errors,
    };
  }

  saveWithSecrets(textOrObj, authStore) {
    const text = typeof textOrObj === "string" ? textOrObj : JSON.stringify(textOrObj, null, 2);
    const validation = validateConfig(text);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const current = this.read();
    const sanitizedServers = {};
    for (const [name, cfg] of Object.entries(validation.servers || {})) {
      const copy = { ...cfg };
      if (cfg.env && typeof cfg.env === "object") {
        const nextEnv = {};
        const newSecrets = {};
        const prevEnv = current.servers?.[name]?.env || {};
        for (const [k, rawVal] of Object.entries(cfg.env)) {
          const valStr = String(rawVal ?? "");
          if (valStr === MASKED_ENV_VALUE) {
            nextEnv[k] = prevEnv[k] ? ENV_SECRET_REF : "";
          } else if (valStr === ENV_SECRET_REF) {
            nextEnv[k] = ENV_SECRET_REF;
          } else if (valStr !== "") {
            newSecrets[k] = valStr;
            nextEnv[k] = ENV_SECRET_REF;
          } else {
            nextEnv[k] = "";
          }
        }
        if (Object.keys(newSecrets).length > 0) {
          if (!authStore || typeof authStore.saveEnvSecrets !== "function") {
            return {
              ok: false,
              errors: ["Electron safeStorage is unavailable; credentials cannot be securely saved."],
            };
          }
          try {
            authStore.saveEnvSecrets(name, newSecrets);
          } catch (err) {
            return { ok: false, errors: [err?.message || "Failed to encrypt MCP secrets"] };
          }
        }
        copy.env = nextEnv;
      }
      sanitizedServers[name] = copy;
    }
    return this.save({ mcpServers: sanitizedServers });
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

  addServer(name, serverConfig, options = {}) {
    const current = this.read();
    const updated = {
      mcpServers: {
        ...(current.servers || {}),
        [name]: serverConfig,
      },
    };
    if (options.authStore) {
      return this.saveWithSecrets(updated, options.authStore);
    }
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
  maskEnvObject,
  maskServersMap,
  hasStdioConfigChanged,
  ENV_SECRET_REF,
  MASKED_ENV_VALUE,
};

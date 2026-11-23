// Read-only discovery and importing of MCP configurations from:
// - Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json)
// - Cursor (%USERPROFILE%\.cursor\mcp.json, %APPDATA%\Cursor\User\globalStorage\mcp.json)
// - Antigravity (%USERPROFILE%\.gemini\antigravity\mcp_config.json)
// INVARIANT: Never log secrets, always mask values in renderer.

const fs = require("fs");
const path = require("path");

function getCandidatePaths() {
  const appData = process.env.APPDATA || "";
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";

  return [
    {
      source: "Claude Desktop",
      sourceKey: "claude-desktop",
      filePath: path.join(appData, "Claude", "claude_desktop_config.json"),
    },
    {
      source: "Cursor",
      sourceKey: "cursor-home",
      filePath: path.join(userProfile, ".cursor", "mcp.json"),
    },
    {
      source: "Cursor",
      sourceKey: "cursor-appdata",
      filePath: path.join(appData, "Cursor", "User", "globalStorage", "mcp.json"),
    },
    {
      source: "Antigravity",
      sourceKey: "antigravity-gemini",
      filePath: path.join(userProfile, ".gemini", "antigravity", "mcp_config.json"),
    },
    {
      source: "Antigravity",
      sourceKey: "antigravity-appdata",
      filePath: path.join(appData, "Antigravity", "mcp.json"),
    },
  ];
}

function hasSecretKeyNames(envObj) {
  if (!envObj || typeof envObj !== "object") return false;
  const keys = Object.keys(envObj);
  return keys.some((k) => /token|key|secret|password|auth|credential/i.test(k));
}

function discoverExternalConfigs(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const candidates = options.candidates || getCandidatePaths();
  const discovered = [];

  for (const candidate of candidates) {
    try {
      if (!fsImpl.existsSync(candidate.filePath)) continue;
      const content = fsImpl.readFileSync(candidate.filePath, "utf-8");
      const parsed = JSON.parse(content);
      const mcpServers = parsed?.mcpServers || parsed?.servers;
      if (!mcpServers || typeof mcpServers !== "object") continue;

      for (const [name, serverCfg] of Object.entries(mcpServers)) {
        if (!serverCfg || typeof serverCfg !== "object") continue;
        const env = serverCfg.env || {};
        const envKeys = Object.keys(env);
        const hasSecrets = hasSecretKeyNames(env);

        // Env details with masked values (never plaintext secrets)
        const envDetails = envKeys.map((k) => ({
          key: k,
          maskedValue: env[k] ? "••••••••" : "",
          isSecret: /token|key|secret|password|auth|credential/i.test(k),
          hasValue: Boolean(env[k]),
        }));

        // Mask config for display
        const safeConfig = { ...serverCfg };
        if (safeConfig.env) {
          const maskedEnv = {};
          for (const k of envKeys) {
            maskedEnv[k] = safeConfig.env[k] ? "••••••••" : "";
          }
          safeConfig.env = maskedEnv;
        }

        discovered.push({
          source: candidate.source,
          sourceKey: candidate.sourceKey,
          filePath: candidate.filePath,
          serverName: name,
          config: safeConfig,
          _rawEnv: env, // Kept internal for import, never sent to renderer
          hasEnvSecrets: hasSecrets,
          envKeys,
          envDetails,
        });
      }
    } catch {
      // Ignore unreadable or invalid files
    }
  }

  return discovered;
}

function importSelectedServers(selectedList = [], { mcpConfigStore, envImportChoices = {}, importEnvValues = false }) {
  if (!mcpConfigStore || !Array.isArray(selectedList)) {
    return { ok: false, imported: 0, errors: ["Invalid arguments"] };
  }

  const current = mcpConfigStore.read();
  const servers = { ...(current.servers || {}) };
  let importedCount = 0;

  for (const item of selectedList) {
    const name = item.serverName || item.name;
    const cfg = item.config;
    if (!name || !cfg) continue;

    const newCfg = { ...cfg };
    const rawEnv = item._rawEnv || cfg.env || {};
    const serverChoices = envImportChoices[name] || {};

    if (newCfg.env || item._rawEnv) {
      const newEnv = {};
      const keys = Object.keys(rawEnv);
      for (const k of keys) {
        // Copy secret/value only if explicitly allowed per key or blanket importEnvValues
        if (serverChoices[k] === true || (importEnvValues && serverChoices[k] !== false)) {
          newEnv[k] = rawEnv[k] || "";
        } else {
          newEnv[k] = ""; // Keep placeholder key without value
        }
      }
      newCfg.env = newEnv;
    }

    servers[name] = newCfg;
    importedCount++;
  }

  const saveRes = mcpConfigStore.save({ mcpServers: servers });
  return {
    ok: saveRes.ok,
    imported: importedCount,
    errors: saveRes.errors || [],
  };
}

module.exports = {
  getCandidatePaths,
  discoverExternalConfigs,
  importSelectedServers,
  hasSecretKeyNames,
};

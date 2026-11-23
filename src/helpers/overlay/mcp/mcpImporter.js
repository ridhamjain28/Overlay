// Read-only discovery and importing of MCP configurations from:
// - Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json)
// - Cursor (%USERPROFILE%\.cursor\mcp.json, %APPDATA%\Cursor\User\globalStorage\mcp.json)
// - Antigravity (%USERPROFILE%\.gemini\antigravity\mcp_config.json)

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

        discovered.push({
          source: candidate.source,
          sourceKey: candidate.sourceKey,
          filePath: candidate.filePath,
          serverName: name,
          config: serverCfg,
          hasEnvSecrets: hasSecrets,
          envKeys,
        });
      }
    } catch {
      // Ignore unreadable or invalid files
    }
  }

  return discovered;
}

function importSelectedServers(selectedList = [], { mcpConfigStore, importEnvValues = false }) {
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
    if (newCfg.env) {
      if (!importEnvValues) {
        // Redact or clear env values if user opted not to import env
        const emptyEnv = {};
        for (const k of Object.keys(newCfg.env)) {
          emptyEnv[k] = "";
        }
        newCfg.env = emptyEnv;
      } else {
        newCfg.env = { ...newCfg.env };
      }
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

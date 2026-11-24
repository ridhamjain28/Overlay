// Read-only discovery and importing of MCP configurations from:
// - Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json)
// - Cursor (%USERPROFILE%\.cursor\mcp.json, %APPDATA%\Cursor\User\globalStorage\mcp.json)
// - Antigravity (%USERPROFILE%\.gemini\antigravity\mcp_config.json)
// INVARIANT: Raw env values NEVER leave the main process (no _rawEnv sent to renderer).
// INVARIANT: Secrets are encrypted via safeStorage (authStore), never written plaintext to mcp.json.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ENV_SECRET_REF, MASKED_ENV_VALUE } = require("./mcpAuth");

const defaultDiscoveredRegistry = new Map();

function makeOpaqueDiscoveryId(sourceKey, serverName) {
  return crypto
    .createHash("sha256")
    .update(`${String(sourceKey || "")}\0${String(serverName || "")}`)
    .digest("hex")
    .slice(0, 24);
}

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
  const registry = options.discoveredStore || defaultDiscoveredRegistry;
  registry.clear();

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
        const env = serverCfg.env && typeof serverCfg.env === "object" ? { ...serverCfg.env } : {};
        const envKeys = Object.keys(env);
        const hasSecrets = hasSecretKeyNames(env) || envKeys.some((k) => Boolean(env[k]));
        const id = makeOpaqueDiscoveryId(candidate.sourceKey, name);

        const envDetails = envKeys.map((k) => ({
          key: k,
          maskedValue: env[k] ? MASKED_ENV_VALUE : "",
          isSecret: /token|key|secret|password|auth|credential/i.test(k),
          hasValue: Boolean(env[k]),
        }));

        const safeConfig = { ...serverCfg };
        if (safeConfig.env) {
          const maskedEnv = {};
          for (const k of envKeys) {
            maskedEnv[k] = safeConfig.env[k] ? MASKED_ENV_VALUE : "";
          }
          safeConfig.env = maskedEnv;
        }

        const configBase = { ...serverCfg };
        if (configBase.env) {
          delete configBase.env;
        }

        // Keep raw env and trusted config strictly in main-process Map
        registry.set(id, {
          id,
          source: candidate.source,
          sourceKey: candidate.sourceKey,
          filePath: candidate.filePath,
          serverName: name,
          configBase,
          rawEnv: env,
        });

        // Never return _rawEnv or plaintext secret values to renderer
        discovered.push({
          id,
          source: candidate.source,
          sourceKey: candidate.sourceKey,
          filePath: candidate.filePath,
          serverName: name,
          config: safeConfig,
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

function importSelectedServers(
  selectedIdsOrItems = [],
  { mcpConfigStore, authStore, envImportChoices = {}, importEnvValues = false, discoveredStore } = {}
) {
  if (!mcpConfigStore || !Array.isArray(selectedIdsOrItems)) {
    return { ok: false, imported: 0, errors: ["Invalid arguments"] };
  }

  const registry = discoveredStore || defaultDiscoveredRegistry;
  const current = mcpConfigStore.read();
  const servers = { ...(current.servers || {}) };
  let importedCount = 0;

  for (const item of selectedIdsOrItems) {
    // Only trust opaque id from renderer; completely ignore any renderer-supplied config or _rawEnv
    const id = typeof item === "string" ? item : item?.id;
    if (!id || typeof id !== "string") continue;

    const entry = registry.get(id);
    if (!entry) continue;

    const name = entry.serverName;
    const newCfg = { ...entry.configBase };
    const rawEnv = entry.rawEnv || {};
    const keys = Object.keys(rawEnv);
    const serverChoices = envImportChoices[id] || envImportChoices[name] || {};

    if (keys.length > 0) {
      const newEnvRefs = {};
      const secretsToEncrypt = {};

      for (const k of keys) {
        const val = rawEnv[k];
        const approved =
          serverChoices[k] === true || (importEnvValues && serverChoices[k] !== false);
        if (approved && val !== undefined && val !== null && String(val) !== "") {
          secretsToEncrypt[k] = String(val);
          newEnvRefs[k] = ENV_SECRET_REF;
        } else {
          newEnvRefs[k] = "";
        }
      }

      if (Object.keys(secretsToEncrypt).length > 0) {
        if (!authStore || typeof authStore.saveEnvSecrets !== "function") {
          return {
            ok: false,
            imported: 0,
            errors: ["Electron safeStorage is unavailable; credentials cannot be securely saved."],
          };
        }
        try {
          authStore.saveEnvSecrets(name, secretsToEncrypt);
        } catch (err) {
          return {
            ok: false,
            imported: 0,
            errors: [
              err?.message ||
                "Electron safeStorage is unavailable; credentials cannot be securely saved.",
            ],
          };
        }
      }

      newCfg.env = newEnvRefs;
    }

    servers[name] = newCfg;
    importedCount++;
  }

  if (importedCount === 0 && selectedIdsOrItems.length > 0) {
    return { ok: false, imported: 0, errors: ["No matching discovered servers found to import"] };
  }

  const saveRes = mcpConfigStore.save({ mcpServers: servers });
  return {
    ok: saveRes.ok,
    imported: saveRes.ok ? importedCount : 0,
    errors: saveRes.errors || [],
  };
}

module.exports = {
  getCandidatePaths,
  discoverExternalConfigs,
  importSelectedServers,
  hasSecretKeyNames,
  makeOpaqueDiscoveryId,
};

/**
 * Overlay: One-Click System Diagnostics & Self-Healing Report Generator
 *
 * Collects an actionable, sanitized snapshot of the system state:
 * - Overlay version
 * - OS details (Platform, Release, Arch)
 * - Hardware profile summary (CPU cores, total RAM, GPU detection)
 * - Default audio input device status
 * - Ollama reachability (http://127.0.0.1:11434/api/tags)
 * - MCP server statuses
 * - Last 40 lines of sanitized logs
 *
 * STRICT INVARIANT:
 * All tokens, passwords, API keys, Authorization headers, and personal paths
 * (e.g. C:\Users\<username> or /Users/<username>) are scrubbed before export.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const { detectHardware } = require("./hardwareProfile");

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/api/tags";
const DEFAULT_LOG_LINE_LIMIT = 40;

/**
 * Scrubs all tokens, passwords, API keys, Authorization headers, and personal user paths.
 *
 * @param {string} text
 * @param {object} [deps]
 * @returns {string}
 */
function scrubSensitiveData(text, deps = {}) {
  if (typeof text !== "string") return String(text ?? "");
  let scrubbed = text;

  // 1. Scrub explicit home directory if known or discoverable
  const home = deps.homeDir || (typeof os !== "undefined" && typeof os.homedir === "function" ? os.homedir() : null);
  if (home && home.length > 2) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const winHome = home.replace(/\//g, "\\");
    const posixHome = home.replace(/\\/g, "/");
    scrubbed = scrubbed.replace(new RegExp(escapeRe(winHome), "gi"), "~");
    scrubbed = scrubbed.replace(new RegExp(escapeRe(posixHome), "g"), "~");
  }

  // 2. Anonymize personal user paths across platforms
  // Windows: C:\Users\<username> or C:/Users/<username>
  scrubbed = scrubbed.replace(/([A-Za-z]:\\[Uu]sers\\)[^\s\\/"':]+/g, "$1***");
  scrubbed = scrubbed.replace(/([A-Za-z]:\/[Uu]sers\/)[^\s\\/"':]+/g, "$1***");
  // macOS / Linux: /Users/<username> or /home/<username>
  scrubbed = scrubbed.replace(/(\/(?:Users|home)\/)[^\s/\\"':),;\]}]+/g, "$1***");

  // 3. Scrub username from environment if present
  const username = deps.username || process.env.USERNAME || process.env.USER;
  if (username && username.length > 1) {
    const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const userPathRegex = new RegExp(`([\\\\/](?:users|home)[\\\\/])${escapedUser}`, "gi");
    scrubbed = scrubbed.replace(userPathRegex, "$1***");
  }

  // 4. Scrub Authorization headers and authentication tokens
  scrubbed = scrubbed.replace(/(Authorization:\s*Bearer\s+)[^\s\r\n]+/gi, "$1[REDACTED]");
  scrubbed = scrubbed.replace(/(Authorization:\s*Basic\s+)[^\s\r\n]+/gi, "$1[REDACTED]");
  scrubbed = scrubbed.replace(/(\bBearer\s+)[a-zA-Z0-9_\-.~+/=]+/gi, "$1[REDACTED]");
  scrubbed = scrubbed.replace(/(\bBasic\s+)[a-zA-Z0-9+/=]+/gi, "$1[REDACTED]");

  // 5. Scrub well-known API keys and tokens
  // Anthropic (check before OpenAI sk- since it starts with sk-ant-)
  scrubbed = scrubbed.replace(/\bsk-ant-[a-zA-Z0-9_-]{10,}\b/g, "sk-ant-[REDACTED]");
  // OpenAI
  scrubbed = scrubbed.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "sk-[REDACTED]");
  // Google / Gemini
  scrubbed = scrubbed.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "AIza[REDACTED]");
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  scrubbed = scrubbed.replace(/\bgh[pousr][_-][A-Za-z0-9_]{30,}\b/g, "gh[REDACTED]");
  // HuggingFace tokens
  scrubbed = scrubbed.replace(/\bhf_[A-Za-z0-9]{30,}\b/g, "hf_[REDACTED]");
  // AWS Access Key
  scrubbed = scrubbed.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]");
  // Tavily
  scrubbed = scrubbed.replace(/\btvly-[a-zA-Z0-9_-]{16,}\b/g, "tvly-[REDACTED]");
  // OpenClaw
  scrubbed = scrubbed.replace(/\boc_[a-zA-Z0-9_-]{16,}\b/g, "oc-[REDACTED]");

  // 6. Generic secrets in key-value pairs (JSON or plaintext config)
  scrubbed = scrubbed.replace(
    /(["']?(?:(?:[a-z0-9_-]+[_-])?token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"',\s\\}&;\])[\]]{3,})(["']?)/gi,
    (match, p1, p2, p3) => (/^\[REDACTED\]$/i.test(p2) ? match : `${p1}[REDACTED]${p3}`)
  );

  // 7. URL credentials (http://user:password@host)
  scrubbed = scrubbed.replace(/(https?:\/\/)([^:\s]+):([^@\s]+)@/g, "$1$2:[REDACTED]@");

  // 8. Query parameter tokens
  scrubbed = scrubbed.replace(
    /([?&](?:token|key|api_key|apiKey|password|secret|auth)=)[^&\s]+/gi,
    "$1[REDACTED]"
  );

  return scrubbed;
}

/**
 * Checks reachability of local Ollama instance and lists installed models.
 *
 * @param {object} [deps]
 * @returns {Promise<{ reachable: boolean; url: string; status: string; models: string[] }>}
 */
async function checkOllamaReachability(deps = {}) {
  const url = deps.ollamaUrl || DEFAULT_OLLAMA_URL;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = deps.timeoutMs || 2500;

  if (typeof fetchImpl !== "function") {
    return {
      reachable: false,
      url,
      status: "Fetch API unavailable",
      models: [],
    };
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetchImpl(url, {
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);

    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      return {
        reachable: false,
        url,
        status: `HTTP ${res.status} ${res.statusText || ""}`.trim(),
        models: [],
      };
    }

    const data = await res.json().catch(() => null);
    const models = Array.isArray(data?.models)
      ? data.models.map((m) => m?.name || m?.model).filter(Boolean)
      : [];

    return {
      reachable: true,
      url,
      status: "Reachable (200 OK)",
      models,
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const isAbort = err?.name === "AbortError";
    const msg = isAbort
      ? `Timed out after ${timeoutMs}ms`
      : scrubSensitiveData(err?.message || String(err), deps);
    return {
      reachable: false,
      url,
      status: `Unreachable (${msg})`,
      models: [],
    };
  }
}

/**
 * Resolves default audio input device status.
 *
 * @param {object} [deps]
 * @returns {Promise<{ status: string; name: string | null }>}
 */
async function getDefaultAudioStatus(deps = {}) {
  if (deps.defaultAudioDevice !== undefined) {
    if (!deps.defaultAudioDevice) {
      return { status: "None detected / Unavailable", name: null };
    }
    return {
      status: "Available",
      name: scrubSensitiveData(deps.defaultAudioDevice.name || "Default Audio Device", deps),
    };
  }

  try {
    let resolver = deps.resolveSystemDefaultMicrophone;
    if (!resolver) {
      const micModule = require("../systemDefaultMicrophone");
      resolver = micModule.resolveSystemDefaultMicrophone;
    }
    const mic = typeof resolver === "function" ? await resolver(deps) : null;
    if (mic && mic.name) {
      return {
        status: "Available",
        name: scrubSensitiveData(mic.name, deps),
      };
    }
    return {
      status: "None detected / Unavailable",
      name: null,
    };
  } catch (err) {
    return {
      status: `Error detecting device (${scrubSensitiveData(err.message || String(err), deps)})`,
      name: null,
    };
  }
}

/**
 * Summarizes MCP server statuses.
 *
 * @param {object} [deps]
 * @returns {Promise<{ available: boolean; error?: string; servers: Array<object> }>}
 */
async function getMcpServersStatus(deps = {}) {
  const mcpManager = deps.mcpManager;
  if (!mcpManager || typeof mcpManager.listServers !== "function") {
    return { available: false, servers: [] };
  }

  try {
    const servers = await mcpManager.listServers();
    return {
      available: true,
      servers: Array.isArray(servers)
        ? servers.map((s) => ({
            name: s.name,
            type: s.type,
            status: s.status,
            toolsCount: s.toolsCount,
            error: s.error ? scrubSensitiveData(s.error, deps) : null,
          }))
        : [],
    };
  } catch (err) {
    return {
      available: false,
      error: scrubSensitiveData(err.message || String(err), deps),
      servers: [],
    };
  }
}

/**
 * Retrieves and sanitizes the last N lines of logs.
 *
 * @param {object} [deps]
 * @returns {string[]}
 */
function getRecentLogs(deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const parsedMax = Number(deps.maxLines);
  const maxLines =
    Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : DEFAULT_LOG_LINE_LIMIT;

  let rawLines = [];

  if (deps.logs) {
    if (Array.isArray(deps.logs)) {
      rawLines = deps.logs;
    } else if (typeof deps.logs === "string") {
      rawLines = deps.logs.split(/\r?\n/);
    }
  } else {
    let logFile = deps.logPath;
    if (!logFile && deps.debugLogger && typeof deps.debugLogger.getLogPath === "function") {
      logFile = deps.debugLogger.getLogPath();
    }
    if (!logFile) {
      try {
        const debugLogger = require("../debugLogger");
        if (typeof debugLogger.getLogPath === "function") {
          logFile = debugLogger.getLogPath();
        }
      } catch {}
    }

    if (!logFile || !fsImpl.existsSync(logFile)) {
      let userDataDir = deps.userDataDir;
      if (!userDataDir) {
        try {
          const { app } = require("electron");
          if (app && typeof app.getPath === "function") {
            userDataDir = app.getPath("userData");
          }
        } catch {}
      }

      if (userDataDir) {
        const logsDir = path.join(userDataDir, "logs");
        if (fsImpl.existsSync(logsDir)) {
          try {
            const files = fsImpl
              .readdirSync(logsDir)
              .filter((f) => f.endsWith(".log"))
              .map((f) => path.join(logsDir, f));
            if (files.length > 0) {
              files.sort((a, b) => {
                try {
                  return fsImpl.statSync(b).mtimeMs - fsImpl.statSync(a).mtimeMs;
                } catch {
                  return 0;
                }
              });
              logFile = files[0];
            }
          } catch {}
        }
      }
    }

    if (logFile && fsImpl.existsSync(logFile)) {
      try {
        const content = fsImpl.readFileSync(logFile, "utf8");
        rawLines = content.split(/\r?\n/);
      } catch (err) {
        rawLines = [`[ERROR] Could not read log file: ${err.message}`];
      }
    }
  }

  const normalizedLines = rawLines.map((line) => String(line ?? ""));

  // Remove trailing blank lines
  while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1].trim() === "") {
    normalizedLines.pop();
  }

  const slice = normalizedLines.slice(-maxLines);
  if (slice.length === 0) {
    return ["(No log entries recorded)"];
  }

  return slice.map((line) => scrubSensitiveData(line, deps));
}

/**
 * Hardware profile summary.
 *
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function getHardwareSummary(deps = {}) {
  try {
    const hw = await detectHardware(deps);
    return hw;
  } catch {
    const osImpl = deps.osImpl || os;
    const cpus = typeof osImpl.cpus === "function" ? osImpl.cpus() || [] : [];
    const totalRamBytes = typeof osImpl.totalmem === "function" ? Number(osImpl.totalmem()) || 0 : 0;
    return {
      cpuCores: cpus.length || 1,
      totalRamGiB: Math.round((totalRamBytes / (1024 * 1024 * 1024)) * 10) / 10,
      gpuName: null,
      vramMb: null,
      gpuSource: null,
    };
  }
}

/**
 * Formats diagnostic data into clean, copy-pasteable Markdown.
 *
 * @param {object} data
 * @param {object} [deps]
 * @returns {string}
 */
function formatDiagnosticReport(data, deps = {}) {
  const lines = [];

  lines.push("# Overlay Diagnostic Report");
  lines.push("");
  lines.push(`Generated: ${data.timestamp || new Date().toISOString()}`);
  lines.push("");

  lines.push("## System Information");
  lines.push(`- **Overlay Version**: ${data.version || "0.2.1"}`);
  lines.push(`- **Platform**: ${data.os?.platform || process.platform}`);
  lines.push(`- **OS Release**: ${data.os?.release || "unknown"}`);
  lines.push(`- **Architecture**: ${data.os?.arch || process.arch}`);
  lines.push("");

  lines.push("## Hardware Profile");
  lines.push(`- **CPU Cores**: ${data.hardware?.cpuCores ?? "unknown"}`);
  lines.push(
    `- **Total RAM**: ${
      data.hardware?.totalRamGiB != null ? `${data.hardware.totalRamGiB} GiB` : "unknown"
    }`
  );
  if (data.hardware?.gpuName) {
    const vram = data.hardware.vramMb ? ` (${data.hardware.vramMb} MB VRAM)` : "";
    const src = data.hardware.gpuSource ? ` [Source: ${data.hardware.gpuSource}]` : "";
    lines.push(`- **GPU**: ${data.hardware.gpuName}${vram}${src}`);
  } else {
    lines.push("- **GPU**: None detected / Integrated");
  }
  lines.push("");

  lines.push("## Audio Input Status");
  if (data.audio?.name) {
    lines.push(`- **Default Device**: ${data.audio.name}`);
    lines.push(`- **Status**: ${data.audio.status}`);
  } else {
    lines.push(`- **Default Device**: None`);
    lines.push(`- **Status**: ${data.audio?.status || "Unavailable"}`);
  }
  lines.push("");

  lines.push("## Ollama Reachability");
  lines.push(`- **Endpoint**: ${data.ollama?.url || DEFAULT_OLLAMA_URL}`);
  lines.push(`- **Status**: ${data.ollama?.status || "Unknown"}`);
  if (data.ollama?.models && data.ollama.models.length > 0) {
    lines.push(`- **Installed Models**: ${data.ollama.models.join(", ")}`);
  } else if (data.ollama?.reachable) {
    lines.push("- **Installed Models**: (None installed)");
  }
  lines.push("");

  lines.push("## MCP Servers");
  if (!data.mcp?.available) {
    lines.push(
      data.mcp?.error
        ? `- **Status**: Error (${data.mcp.error})`
        : "- **Status**: Not initialized / Not configured"
    );
  } else if (!data.mcp.servers || data.mcp.servers.length === 0) {
    lines.push("- **Servers**: None configured");
  } else {
    for (const server of data.mcp.servers) {
      const typeStr = server.type ? ` [${server.type}]` : "";
      const toolsStr = typeof server.toolsCount === "number" ? `, ${server.toolsCount} tools` : "";
      const errStr = server.error ? ` (Error: ${server.error})` : "";
      lines.push(
        `- **${server.name}**${typeStr}: ${server.status || "unknown"}${toolsStr}${errStr}`
      );
    }
  }
  lines.push("");

  lines.push(`## Recent Logs (Last ${data.logs?.length || 0} lines)`);
  lines.push("```");
  if (Array.isArray(data.logs) && data.logs.length > 0) {
    for (const logLine of data.logs) {
      lines.push(logLine);
    }
  } else {
    lines.push("(No log entries recorded)");
  }
  lines.push("```");
  lines.push("");

  const rawMarkdown = lines.join("\n");
  // Final safeguard scrub across the entire markdown report
  return scrubSensitiveData(rawMarkdown, deps);
}

/**
 * Top-level diagnostic report generator.
 *
 * @param {object} [deps]
 * @returns {Promise<string>}
 */
async function generateDiagnosticReport(deps = {}) {
  let appVersion = deps.appVersion;
  if (!appVersion) {
    try {
      const { app } = require("electron");
      if (app && typeof app.getVersion === "function") {
        appVersion = app.getVersion();
      }
    } catch {}
  }
  if (!appVersion) {
    try {
      const pkg = require("../../../package.json");
      appVersion = pkg.version;
    } catch {}
  }
  if (!appVersion) {
    appVersion = "0.2.1";
  }

  const osImpl = deps.osImpl || os;
  const platform = deps.platform || process.platform;
  const osRelease = deps.osRelease || (typeof osImpl.release === "function" ? osImpl.release() : "unknown");
  const arch = deps.arch || process.arch;

  const [hardware, audio, ollama, mcp] = await Promise.all([
    getHardwareSummary(deps),
    getDefaultAudioStatus(deps),
    checkOllamaReachability(deps),
    getMcpServersStatus(deps),
  ]);

  const logs = getRecentLogs(deps);

  const reportData = {
    timestamp: deps.timestamp || new Date().toISOString(),
    version: appVersion,
    os: { platform, release: osRelease, arch },
    hardware,
    audio,
    ollama,
    mcp,
    logs,
  };

  return formatDiagnosticReport(reportData, deps);
}

module.exports = {
  generateDiagnosticReport,
  formatDiagnosticReport,
  scrubSensitiveData,
  checkOllamaReachability,
  getDefaultAudioStatus,
  getMcpServersStatus,
  getRecentLogs,
  getHardwareSummary,
};

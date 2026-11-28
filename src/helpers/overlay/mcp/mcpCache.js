// On-disk cache for MCP servers' tools and instructions.
// %APPDATA%\Overlay\mcp\<server>\<tool>.json
// %APPDATA%\Overlay\mcp\<server>\instructions.md

const fs = require("fs");
const path = require("path");
const { getMcpConfigDir } = require("./mcpConfig");

function getMcpCacheDir(appDataDir) {
  return path.join(getMcpConfigDir(appDataDir), "mcp");
}

function sanitizeFileName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function saveServerCache(serverName, { tools = [], instructions = "" }, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cacheDir = path.join(getMcpCacheDir(options.appDataDir), sanitizeFileName(serverName));

  try {
    fsImpl.mkdirSync(cacheDir, { recursive: true });

    // Read existing files to prune tools that no longer exist
    let existingFiles = [];
    try {
      existingFiles = fsImpl.readdirSync(cacheDir);
    } catch {}

    const toolFilesWritten = new Set();

    for (const tool of tools) {
      if (!tool || !tool.name) continue;
      const fileName = `${sanitizeFileName(tool.name)}.json`;
      const filePath = path.join(cacheDir, fileName);
      const data = {
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        annotations: tool.annotations || {},
      };
      fsImpl.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
      toolFilesWritten.add(fileName);
    }

    // Clean up old tool json files that were removed
    for (const file of existingFiles) {
      if (file.endsWith(".json") && !toolFilesWritten.has(file)) {
        try {
          fsImpl.unlinkSync(path.join(cacheDir, file));
        } catch {}
      }
    }

    // Write instructions if provided
    const instructionsPath = path.join(cacheDir, "instructions.md");
    if (instructions && typeof instructions === "string" && instructions.trim()) {
      fsImpl.writeFileSync(instructionsPath, instructions, "utf-8");
    } else {
      try {
        if (fsImpl.existsSync(instructionsPath)) fsImpl.unlinkSync(instructionsPath);
      } catch {}
    }
  } catch {
    // Cache write failure should not crash
  }
}

function readServerCache(serverName, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cacheDir = path.join(getMcpCacheDir(options.appDataDir), sanitizeFileName(serverName));
  const tools = [];
  let instructions = "";

  try {
    if (!fsImpl.existsSync(cacheDir)) {
      return { tools: [], instructions: "" };
    }

    const files = fsImpl.readdirSync(cacheDir);
    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      if (file === "instructions.md") {
        try {
          instructions = fsImpl.readFileSync(filePath, "utf-8");
        } catch {}
      } else if (file.endsWith(".json")) {
        try {
          const raw = fsImpl.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed && parsed.name) {
            tools.push({
              server: serverName,
              name: parsed.name,
              description: parsed.description || "",
              inputSchema: parsed.inputSchema || { type: "object", properties: {} },
              annotations: parsed.annotations || {},
            });
          }
        } catch {}
      }
    }
  } catch {}

  return { tools, instructions };
}

function readAllCachedTools(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const baseDir = getMcpCacheDir(options.appDataDir);
  const allTools = [];

  try {
    if (!fsImpl.existsSync(baseDir)) return [];
    const servers = fsImpl.readdirSync(baseDir, { withFileTypes: true });
    for (const s of servers) {
      if (s.isDirectory()) {
        const { tools } = readServerCache(s.name, options);
        allTools.push(...tools);
      }
    }
  } catch {}

  return allTools;
}

function removeServerCache(serverName, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cacheDir = path.join(getMcpCacheDir(options.appDataDir), sanitizeFileName(serverName));
  try {
    if (fsImpl.existsSync(cacheDir)) {
      fsImpl.rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch {}
}

module.exports = {
  getMcpCacheDir,
  saveServerCache,
  readServerCache,
  readAllCachedTools,
  removeServerCache,
};

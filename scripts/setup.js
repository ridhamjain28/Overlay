#!/usr/bin/env node
/**
 * Overlay one-step setup: `npm run setup` (or double-click setup.bat).
 *
 * 1. checks Node.js 24+
 * 2. installs packages (`npm ci`) unless they are already up to date
 * 3. downloads the local Whisper engine (whisper.cpp server)
 * 4. builds the UI once so `npm start` works
 * 5. checks Ollama is installed and running, and pulls the models if missing
 * 6. creates the user-data .env from .env.example with every key commented out
 *
 * It never deletes models, never overwrites an existing .env and never prints keys.
 * Flags: --force-install  --skip-install  --skip-whisper  --skip-build
 *        --skip-models  --only-default-model
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OLLAMA_URL = (process.env.OLLAMA_HOST_URL || "http://localhost:11434").replace(/\/+$/, "");
const DEFAULT_MODEL = "qwen3:8b";
const FALLBACK_MODEL = "qwen3:4b-instruct";
const KEY_NAME = /^[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)$/;

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  return {
    forceInstall: flags.has("--force-install"),
    skipInstall: flags.has("--skip-install"),
    skipWhisper: flags.has("--skip-whisper"),
    skipBuild: flags.has("--skip-build"),
    skipModels: flags.has("--skip-models"),
    onlyDefaultModel: flags.has("--only-default-model"),
  };
}

function nodeMajor(version = process.versions.node) {
  return Number(String(version).split(".")[0]) || 0;
}

/** npm ci is needed when node_modules is missing or older than package-lock.json. */
function needsInstall(root = ROOT) {
  const marker = path.join(root, "node_modules", ".package-lock.json");
  const lock = path.join(root, "package-lock.json");
  if (!fs.existsSync(marker)) return true;
  try {
    return fs.statSync(lock).mtimeMs > fs.statSync(marker).mtimeMs;
  } catch {
    return true;
  }
}

/** Models from `wanted` that are not in Ollama's list. "name" and "name:latest" match. */
function missingModels(installed, wanted) {
  const have = new Set();
  for (const name of installed || []) {
    have.add(name);
    if (name.endsWith(":latest")) have.add(name.slice(0, -":latest".length));
  }
  return wanted.filter((m) => !have.has(m));
}

/**
 * Turn .env.example into a starter .env. Key, token and secret lines are
 * commented out so an empty value never hides a key set in Windows' own
 * environment variables (Overlay's .env wins over system variables).
 */
function buildUserEnv(exampleText) {
  const all = exampleText.split(/\r?\n/);
  // Drop the example file's own intro (the first comment block); our header replaces it.
  let start = 0;
  while (start < all.length && all[start].startsWith("#")) start++;
  const lines = all.slice(start).map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) return line;
    if (KEY_NAME.test(m[1]) || m[2] === "") return `# ${m[1]}=`;
    return line;
  });
  const header = [
    "# Overlay settings for this PC. Created by `npm run setup`.",
    "# To add a key: remove the leading '# ' and paste the key after '='.",
    "# This file lives outside the repository; never commit or share it.",
    "",
  ];
  return header.concat(lines).join(os.EOL);
}

/** The folders Overlay reads its .env from (installed app and `npm run dev`). */
function userDataDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  let base;
  if (platform === "win32") base = env.APPDATA || path.join(home, "AppData", "Roaming");
  else if (platform === "darwin") base = path.join(home, "Library", "Application Support");
  else base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [path.join(base, "Overlay"), path.join(base, "Overlay-development")];
}

function ensureUserEnv(dirs = userDataDirs(), examplePath = path.join(ROOT, ".env.example")) {
  const example = fs.readFileSync(examplePath, "utf8");
  return dirs.map((dir) => {
    const file = path.join(dir, ".env");
    if (fs.existsSync(file)) return { file, created: false };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buildUserEnv(example), { encoding: "utf8", flag: "wx" });
    return { file, created: true };
  });
}

// ---------- running things ----------

function npm(args) {
  // Prefer the npm that launched us (no shell, so paths with spaces are safe).
  const npmCli = process.env.npm_execpath;
  const r =
    npmCli && /\.c?js$/.test(npmCli)
      ? spawnSync(process.execPath, [npmCli, ...args], { cwd: ROOT, stdio: "inherit" })
      : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
          cwd: ROOT,
          stdio: "inherit",
          shell: process.platform === "win32",
        });
  return r.status === 0;
}

async function listModels(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models || []).map((m) => m.name || m.model).filter(Boolean);
  } catch {
    return null;
  }
}

function findOllama() {
  const candidates = [];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"));
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ollama"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (which.status === 0) candidates.push(...which.stdout.split(/\r?\n/).filter(Boolean));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function startOllama(exe) {
  const child = spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const models = await listModels();
    if (models) return models;
  }
  return null;
}

async function pullModel(name) {
  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}`);
  let buffer = "";
  let lastShown = -10;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.total && msg.completed) {
        const pct = Math.floor((msg.completed / msg.total) * 100);
        if (pct >= lastShown + 10) {
          lastShown = pct;
          console.log(`    ${name}: ${pct}%`);
        }
      }
      if (msg.status === "success") return;
    }
  }
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const todo = [];
  const step = (n, text) => console.log(`\n[${n}/6] ${text}`);

  step(1, "Node.js version");
  if (nodeMajor() < 24) {
    console.error(`  Overlay needs Node.js 24 or newer; you have ${process.versions.node}.`);
    console.error("  Install it from https://nodejs.org (or: winget install OpenJS.NodeJS)");
    process.exit(1);
  }
  console.log(`  OK (${process.versions.node})`);

  step(2, "Packages (npm ci)");
  if (opts.skipInstall) console.log("  skipped (--skip-install)");
  else if (!opts.forceInstall && !needsInstall()) console.log("  already installed, skipping");
  else if (!npm(["ci"])) {
    console.error("  npm ci failed. Fix the error above and run `npm run setup` again.");
    process.exit(1);
  }

  // Electron downloads its runtime the first time it is loaded; do it now, not at first launch.
  if (!opts.skipInstall) {
    const r = spawnSync(process.execPath, ["-e", "require('electron')"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0)
      todo.push("Electron runtime download failed: run `npx install-electron --no`");
    else console.log("  Electron runtime ready");
  }

  step(3, "Local Whisper engine");
  if (opts.skipWhisper) console.log("  skipped (--skip-whisper)");
  else if (!npm(["run", "download:whisper-cpp"]))
    todo.push("Whisper download failed: run `npm run download:whisper-cpp`");

  step(4, "Build the UI (so `npm start` works)");
  if (opts.skipBuild) console.log("  skipped (--skip-build)");
  else if (!npm(["run", "build:renderer"]))
    todo.push("UI build failed: run `npm run build:renderer`");

  step(5, "Ollama and models");
  if (opts.skipModels) {
    console.log("  skipped (--skip-models)");
  } else {
    let models = await listModels();
    if (!models) {
      const exe = findOllama();
      if (exe) {
        console.log("  Ollama is installed but not running; starting it in the background...");
        models = await startOllama(exe);
      }
    }
    if (!models) {
      console.log("  Ollama not found or not running.");
      todo.push(
        "Install Ollama (https://ollama.com/download or `winget install Ollama.Ollama`), start it, then run `npm run setup` again"
      );
    } else {
      const wanted = opts.onlyDefaultModel ? [DEFAULT_MODEL] : [DEFAULT_MODEL, FALLBACK_MODEL];
      const missing = missingModels(models, wanted);
      if (missing.length === 0) console.log(`  OK, models present: ${wanted.join(", ")}`);
      for (const name of missing) {
        console.log(`  pulling ${name} (this can take a while)...`);
        try {
          await pullModel(name);
          console.log(`  ${name} ready`);
        } catch (err) {
          todo.push(`Pull failed for ${name} (${err.message}): run \`ollama pull ${name}\``);
        }
      }
    }
  }

  step(6, "Settings file for your keys");
  for (const { file, created } of ensureUserEnv()) {
    console.log(`  ${created ? "created" : "already exists, left unchanged"}: ${file}`);
  }
  console.log("  Keys are optional. Open the file and remove '# ' in front of a key to use it.");

  console.log("\n----------------------------------------");
  if (todo.length) {
    console.log("Setup finished with things for you to do:");
    for (const t of todo) console.log(`  - ${t}`);
    process.exitCode = 2;
  } else {
    console.log(
      "Setup complete. Start Overlay with:  npm start   (or `npm run dev` for development)"
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Setup failed:", err.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  parseArgs,
  nodeMajor,
  needsInstall,
  missingModels,
  buildUserEnv,
  userDataDirs,
  ensureUserEnv,
};

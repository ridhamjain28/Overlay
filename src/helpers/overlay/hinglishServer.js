// Overlay: keeps the optional Hinglish speech server running (main process).
//
// The server (hinglish-asr/server.py) turns mixed Hindi + English speech into
// Roman-script Hinglish. It only starts once the speech helper and its model
// are on this PC, runs hidden (no console window), prefers the GPU, is
// restarted if it dies and is stopped when Overlay quits.
//
// Test/diagnostic switches (environment variables):
//   OVERLAY_HINGLISH_PORT     port to use (default 8765)
//   OVERLAY_HINGLISH_DEVICE   "cuda" or "cpu" (default cuda, falls back to cpu)

const path = require("path");
const fs = require("fs");
const os = require("os");
const childProcess = require("child_process");

const HINGLISH_MODEL_REPO = "MSpider3/whisper-hindi2hinglish-swift-ct2";
const DEFAULT_PORT = 8765;
const READY_TIMEOUT_MS = 4 * 60 * 1000; // first GPU load can take a while
const POLL_MS = 750;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_DELAY_MS = 2000;

function venvPython(venvDir, platform = process.platform) {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/** Hugging Face hub cache folder, the same one huggingface_hub would use. */
function hfHubCache(env = process.env, homedir = os.homedir()) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HUGGINGFACE_HUB_CACHE) return env.HUGGINGFACE_HUB_CACHE;
  if (env.HF_HOME) return path.join(env.HF_HOME, "hub");
  const xdg = env.XDG_CACHE_HOME || path.join(homedir, ".cache");
  return path.join(xdg, "huggingface", "hub");
}

function modelCacheDir(env, homedir) {
  return path.join(hfHubCache(env, homedir), `models--${HINGLISH_MODEL_REPO.replace("/", "--")}`);
}

function safeReaddir(fsImpl, dir) {
  try {
    return fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
}

/** True when faster-whisper is installed in the venv (no Python needed to check). */
function venvHasLibs(venvDir, { fsImpl = fs, platform = process.platform } = {}) {
  const roots =
    platform === "win32"
      ? [path.join(venvDir, "Lib", "site-packages")]
      : safeReaddir(fsImpl, path.join(venvDir, "lib"))
          .filter((n) => n.startsWith("python"))
          .map((n) => path.join(venvDir, "lib", n, "site-packages"));
  return roots.some((root) =>
    ["faster_whisper", "fastapi", "uvicorn"].every((pkg) => fsImpl.existsSync(path.join(root, pkg)))
  );
}

/** True when a downloaded snapshot of the model is in the cache. */
function modelDownloaded({ env = process.env, homedir = os.homedir(), fsImpl = fs } = {}) {
  const snapshots = path.join(modelCacheDir(env, homedir), "snapshots");
  return safeReaddir(fsImpl, snapshots).some(
    (rev) => safeReaddir(fsImpl, path.join(snapshots, rev)).length > 0
  );
}

/** Program, arguments and environment used to start the server. */
function buildLaunch({
  venvDir,
  serverScript,
  port = DEFAULT_PORT,
  logDir,
  env = process.env,
  platform = process.platform,
}) {
  const device = (env.OVERLAY_HINGLISH_DEVICE || "cuda").toLowerCase() === "cpu" ? "cpu" : "cuda";
  return {
    file: venvPython(venvDir, platform),
    args: ["-u", serverScript],
    options: {
      cwd: path.dirname(serverScript),
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        HINGLISH_ASR_MODEL: HINGLISH_MODEL_REPO,
        HINGLISH_ASR_HOST: "127.0.0.1",
        HINGLISH_ASR_PORT: String(port),
        HINGLISH_ASR_DEVICE: device,
        HINGLISH_ASR_PRELOAD: "1",
        ...(logDir ? { HINGLISH_ASR_LOG_DIR: logDir } : {}),
        // The model is already downloaded: no network, no progress bars.
        HF_HUB_OFFLINE: "1",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
      },
    },
  };
}

/**
 * Creates the manager. Everything that touches the PC is injectable so it can
 * be tested without Python, a GPU or a network.
 */
function createHinglishServer(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const fsImpl = deps.fsImpl || fs;
  const homedir = deps.homedir || os.homedir();
  const spawnImpl = deps.spawn || childProcess.spawn;
  const fetchImpl = deps.fetch || ((...a) => globalThis.fetch(...a));
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.logger || {};
  const port = Number(env.OVERLAY_HINGLISH_PORT) || DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const venvDirs = (deps.venvDirs || []).filter(Boolean);
  const serverScripts = (deps.serverScripts || []).filter(Boolean);
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;

  let child = null;
  let state = "stopped"; // not-installed | stopped | starting | ready | failed
  let device = null;
  let lastError = null;
  let starting = null;
  let stopping = false;
  let adopted = false;
  let disposed = false;
  const restarts = [];

  function findInstall() {
    const serverScript = serverScripts.find((p) => fsImpl.existsSync(p));
    if (!serverScript) return null;
    const venvDir = venvDirs.find(
      (dir) =>
        fsImpl.existsSync(venvPython(dir, platform)) && venvHasLibs(dir, { fsImpl, platform })
    );
    if (!venvDir) return null;
    if (!modelDownloaded({ env, homedir, fsImpl })) return null;
    return { venvDir, serverScript };
  }

  async function health() {
    try {
      const res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch {
      return null;
    }
  }

  function status() {
    return { state, ready: state === "ready", device, error: lastError };
  }

  async function waitUntilReady() {
    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      if (!adopted && !child) return false; // it exited while loading
      const h = await health();
      if (h?.loaded) {
        device = h.device || null;
        return true;
      }
      await sleep(POLL_MS);
    }
    return false;
  }

  function spawnServer(install) {
    const launch = buildLaunch({
      ...install,
      port,
      logDir: deps.logDir,
      env,
      platform,
    });
    let proc;
    try {
      proc = spawnImpl(launch.file, launch.args, launch.options);
    } catch (error) {
      lastError = error.message;
      return null;
    }
    const tail = [];
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    proc.stdout?.on?.("data", keep);
    proc.stderr?.on?.("data", keep);
    proc.on?.("error", (error) => {
      lastError = error.message;
    });
    proc.on?.("exit", (code) => {
      if (child === proc) child = null;
      if (stopping) return;
      lastError = tail.at(-1) || `Exited with code ${code}`;
      log.warn?.("Hinglish speech server stopped", { code, last: lastError });
      scheduleRestart();
    });
    return proc;
  }

  function scheduleRestart() {
    const t = now();
    while (restarts.length && t - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) {
      state = "failed";
      return;
    }
    restarts.push(t);
    state = "starting";
    sleep(RESTART_DELAY_MS)
      .then(() => starting)
      .then(() => {
        if (!stopping && !child && state !== "failed") ensure();
      });
  }

  /** Start the server if it is installed and not running. Resolves to status(). */
  function ensure() {
    if (state === "ready" && (child || adopted)) return Promise.resolve(status());
    if (state === "failed" || disposed) return Promise.resolve(status());
    if (starting) return starting;
    stopping = false;
    starting = (async () => {
      // Someone already runs it (e.g. start.bat): use that one.
      const existing = await health();
      if (existing && (!existing.model || existing.model === HINGLISH_MODEL_REPO)) {
        adopted = true;
        if (existing.loaded || (await waitUntilReady())) {
          device = existing.device || device;
          state = "ready";
        } else {
          adopted = false;
          state = "stopped";
        }
        return status();
      }
      adopted = false;
      const install = findInstall();
      if (!install) {
        state = "not-installed";
        return status();
      }
      state = "starting";
      child = spawnServer(install);
      if (!child) {
        state = "failed";
        return status();
      }
      log.info?.("Hinglish speech server starting", { port });
      if (await waitUntilReady()) {
        state = "ready";
        lastError = null;
        log.info?.("Hinglish speech server ready", { device });
      } else if (child) {
        // Still alive but never answered: stop it and let a later call retry.
        lastError = lastError || "Did not become ready in time";
        stop();
        state = "stopped";
        stopping = false;
      } else if (state !== "failed") {
        state = "stopped"; // it exited while loading; a restart is queued
      }
      return status();
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  function stop() {
    stopping = true;
    const proc = child;
    child = null;
    if (proc && proc.exitCode == null) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
    if (state !== "not-installed") state = "stopped";
  }

  /**
   * Transcribe one recording. Never throws. When the server is not ready it
   * starts it in the background and returns { success: false, code: "NOT_READY" }
   * so the caller can use the normal path for this one.
   */
  async function transcribe(audio, { mimeType = "audio/webm", prompt, timeoutMs = 120000 } = {}) {
    if (state !== "ready") {
      ensure().catch(() => {});
      return { success: false, code: "NOT_READY" };
    }
    try {
      const type = String(mimeType || "audio/webm");
      const ext = type.includes("wav") ? "wav" : type.includes("ogg") ? "ogg" : "webm";
      const form = new FormData();
      form.append("file", new Blob([audio], { type }), `audio.${ext}`);
      form.append("language", "hi");
      form.append("response_format", "json");
      if (prompt) form.append("prompt", String(prompt).slice(0, 800));
      const res = await fetchImpl(`${baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { success: false, code: `HTTP_${res.status}` };
      const data = await res.json();
      return { success: true, text: typeof data?.text === "string" ? data.text : "" };
    } catch (error) {
      if (!(await health())) {
        state = "stopped";
        ensure().catch(() => {});
      }
      return { success: false, code: "REQUEST_FAILED", error: error.message };
    }
  }

  /** Stop for good (app quit): no restarts after this. */
  function shutdown() {
    disposed = true;
    stop();
  }

  /** Forget a "failed" or "not-installed" result, e.g. after an install. */
  function reset() {
    if (state === "failed" || state === "not-installed") state = "stopped";
    restarts.length = 0;
  }

  return { ensure, stop, shutdown, status, transcribe, reset, findInstall, baseUrl };
}

module.exports = {
  HINGLISH_MODEL_REPO,
  DEFAULT_PORT,
  createHinglishServer,
  buildLaunch,
  hfHubCache,
  modelDownloaded,
  venvHasLibs,
  venvPython,
};

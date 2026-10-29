// Overlay: first-run requirements checklist (main process).
//
// Checks what Overlay needs on this PC and installs a missing piece with one
// click. Every command is fixed here; the renderer only sends an item id, so
// it can never run anything else. Installs run hidden (windowsHide, no shell)
// and stream their output back line by line.
//
// Test/diagnostic switches (environment variables):
//   OVERLAY_PYTHON_PATH          python.exe, or a folder to look in. An empty
//                                folder simulates "Python is not installed".
//   OVERLAY_OLLAMA_PATH          same idea for ollama.exe
//   OVERLAY_REQUIREMENTS_DRY_RUN "1" = show the commands, never run them

const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");

const DEFAULT_ANSWER_MODEL = "qwen3.5:4b-q4_K_M";
const HINGLISH_MODEL_REPO = "MSpider3/whisper-hindi2hinglish-swift-ct2";
const HINGLISH_IMPORTS = ["faster_whisper", "fastapi", "uvicorn", "multipart"];
const OLLAMA_URL = "http://127.0.0.1:11434";
const MIN_PYTHON = [3, 10];

const WINGET_FLAGS = [
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
];

function quote(arg) {
  const s = String(arg);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function formatCommand(step) {
  return [step.file, ...step.args].map(quote).join(" ");
}

/** Run a program and collect its output. Never throws. */
function runCapture(execImpl, file, args, timeout = 15000) {
  return new Promise((resolve) => {
    try {
      execImpl(
        file,
        args,
        { windowsHide: true, timeout, encoding: "utf8" },
        (error, stdout = "", stderr = "") => {
          resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
        }
      );
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: error.message });
    }
  });
}

function parsePythonVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ""));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +(m[3] || 0), text: m[0] };
}

function isSupportedPython(v) {
  if (!v) return false;
  if (v.major !== MIN_PYTHON[0]) return v.major > MIN_PYTHON[0];
  return v.minor >= MIN_PYTHON[1];
}

function exeName(base, platform) {
  return platform === "win32" ? `${base}.exe` : base;
}

/** Files to try for Python, most specific first. */
function pythonCandidates({ env = process.env, platform = process.platform, fsImpl = fs } = {}) {
  const override = env.OVERLAY_PYTHON_PATH;
  if (override) {
    // An override is final: if nothing usable is there, Python counts as missing.
    let isDir = false;
    try {
      isDir = fsImpl.statSync(override).isDirectory();
    } catch {
      return [];
    }
    if (!isDir) return [{ file: override, args: [] }];
    return ["python", "python3"]
      .map((b) => path.join(override, exeName(b, platform)))
      .filter((p) => fsImpl.existsSync(p))
      .map((file) => ({ file, args: [] }));
  }
  const list = [];
  if (platform === "win32") {
    // Right after `winget install` the app's PATH is stale, so look in the
    // standard install folders directly as well.
    const roots = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Python"),
      env.ProgramFiles,
    ].filter(Boolean);
    for (const minor of [12, 11, 10, 13]) {
      for (const root of roots) {
        const file = path.join(root, `Python3${minor}`, "python.exe");
        if (fsImpl.existsSync(file)) list.push({ file, args: [] });
      }
      list.push({ file: "py", args: [`-3.${minor}`] });
    }
    list.push({ file: "python", args: [] });
  } else {
    list.push({ file: "python3", args: [] }, { file: "python", args: [] });
  }
  return list;
}

const PY_PROBE = "import sys;print(sys.executable);print('%d.%d.%d' % sys.version_info[:3])";

/** First Python 3.10+ found, as { path, version } or null. */
async function findPython(deps = {}) {
  const execImpl = deps.execFile || childProcess.execFile;
  let tooOld = null;
  for (const c of pythonCandidates(deps)) {
    const r = await runCapture(execImpl, c.file, [...c.args, "-c", PY_PROBE]);
    if (!r.ok) continue;
    const [exe, ver] = r.stdout.trim().split(/\r?\n/);
    const version = parsePythonVersion(ver);
    if (!version) continue;
    const found = { path: (exe || c.file).trim(), version: version.text };
    if (isSupportedPython(version)) return found;
    tooOld = tooOld || found;
  }
  return tooOld ? { ...tooOld, tooOld: true } : null;
}

function findOllama({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  execSync,
} = {}) {
  if (env.OVERLAY_OLLAMA_PATH) {
    const p = env.OVERLAY_OLLAMA_PATH;
    try {
      if (fsImpl.statSync(p).isDirectory()) {
        const file = path.join(p, exeName("ollama", platform));
        return fsImpl.existsSync(file) ? file : null;
      }
      return p;
    } catch {
      return null;
    }
  }
  const candidates = [];
  if (platform === "win32" && env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"));
  }
  if (platform === "darwin") candidates.push("/usr/local/bin/ollama", "/opt/homebrew/bin/ollama");
  if (platform === "linux") candidates.push("/usr/local/bin/ollama", "/usr/bin/ollama");
  const hit = candidates.find((p) => fsImpl.existsSync(p));
  if (hit) return hit;
  try {
    const run = execSync || childProcess.execFileSync;
    const out = run(platform === "win32" ? "where" : "which", ["ollama"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(out).split(/\r?\n/).find(Boolean) || null;
  } catch {
    return null;
  }
}

/** Model names in the running Ollama, or null when it is not reachable. */
async function listOllamaTags(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models || []).map((m) => m.name || m.model).filter(Boolean);
  } catch {
    return null;
  }
}

function hasModel(installed, wanted) {
  return (installed || []).some((n) => n === wanted || n === `${wanted}:latest`);
}

function venvPython(venvDir, platform = process.platform) {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/**
 * Creates the checker. Everything that touches the PC is injectable so the
 * logic can be tested without Python, Ollama or a network.
 */
function createRequirements(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const fsImpl = deps.fsImpl || fs;
  const execImpl = deps.execFile || childProcess.execFile;
  const spawnImpl = deps.spawn || childProcess.spawn;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const userDataDir = deps.userDataDir || path.join(require("os").tmpdir(), "overlay");
  const requirementsFile = deps.hinglishRequirementsFile;
  const hinglishVenv = path.join(userDataDir, "hinglish-asr", ".venv");
  const dryRunDefault = deps.dryRun ?? env.OVERLAY_REQUIREMENTS_DRY_RUN === "1";
  const probe = { env, platform, fsImpl, execFile: execImpl, execSync: deps.execSync };

  async function hinglishLibsReady() {
    const py = venvPython(hinglishVenv, platform);
    if (!fsImpl.existsSync(py)) return false;
    const r = await runCapture(
      execImpl,
      py,
      ["-c", `import ${HINGLISH_IMPORTS.join(", ")}`],
      30000
    );
    return r.ok;
  }

  async function hinglishModelReady() {
    const py = venvPython(hinglishVenv, platform);
    if (!fsImpl.existsSync(py)) return false;
    const code =
      "from huggingface_hub import snapshot_download;" +
      `snapshot_download('${HINGLISH_MODEL_REPO}', local_files_only=True)`;
    const r = await runCapture(execImpl, py, ["-c", code], 30000);
    return r.ok;
  }

  /** Current state of every item. `includeHinglish` adds the optional Hindi items. */
  async function check({ includeHinglish = false, answerModel = DEFAULT_ANSWER_MODEL } = {}) {
    const items = [];
    const [ollamaPath, tags] = await Promise.all([
      Promise.resolve(findOllama(probe)),
      listOllamaTags(fetchImpl),
    ]);
    const running = Array.isArray(tags);

    items.push({
      id: "ollama",
      label: "Ollama (runs answers on this PC)",
      optional: false,
      status: running ? "ok" : ollamaPath ? "stopped" : "missing",
      detail: running
        ? "Installed and running"
        : ollamaPath
          ? "Installed but not running"
          : "Not installed",
      command: running ? null : ollamaPath ? null : formatCommand(installSteps("ollama")[0]),
      actionLabel: running ? null : ollamaPath ? "Start" : "Install",
    });

    const modelReady = running && hasModel(tags, answerModel);
    items.push({
      id: "answer-model",
      label: `Answer model (${answerModel})`,
      optional: false,
      status: modelReady ? "ok" : "missing",
      detail: modelReady
        ? "Downloaded"
        : running
          ? "Not downloaded yet (about 3 GB)"
          : "Needs Ollama running first",
      command: modelReady ? null : `ollama pull ${answerModel}`,
      actionLabel: modelReady ? null : "Download",
      blockedBy: running ? null : "ollama",
    });

    if (includeHinglish) {
      const python = await findPython(probe);
      const pyOk = !!python && !python.tooOld;
      items.push({
        id: "python",
        label: "Python 3.10 or newer",
        optional: true,
        status: pyOk ? "ok" : "missing",
        detail: pyOk
          ? `Python ${python.version}`
          : python?.tooOld
            ? `Python ${python.version} is too old`
            : "Not found",
        command: pyOk ? null : formatCommand(installSteps("python")[0]),
        actionLabel: pyOk ? null : "Install",
      });
      const libsOk = pyOk && (await hinglishLibsReady());
      items.push({
        id: "hinglish-libs",
        label: "Hinglish speech helper",
        optional: true,
        status: libsOk ? "ok" : "missing",
        detail: libsOk ? "Installed" : pyOk ? "Not installed (about 1.5 GB)" : "Needs Python first",
        command: libsOk
          ? null
          : formatCommand(
              installSteps("hinglish-libs", { python: python?.path || "python" }).at(-1)
            ),
        actionLabel: libsOk ? null : "Install",
        blockedBy: pyOk ? null : "python",
      });
      const modelOk = libsOk && (await hinglishModelReady());
      items.push({
        id: "hinglish-model",
        label: "Hinglish speech model",
        optional: true,
        status: modelOk ? "ok" : "missing",
        detail: modelOk
          ? "Downloaded"
          : libsOk
            ? "Not downloaded yet (about 1 GB)"
            : "Needs the speech helper first",
        command: modelOk ? null : formatCommand(installSteps("hinglish-model")[0]),
        actionLabel: modelOk ? null : "Download",
        blockedBy: libsOk ? null : "hinglish-libs",
      });
    }
    return { items };
  }

  /** The exact programs an install runs, in order. */
  function installSteps(id, ctx = {}) {
    switch (id) {
      case "python":
        return [
          {
            file: "winget",
            args: ["install", "-e", "--id", "Python.Python.3.12", ...WINGET_FLAGS],
          },
        ];
      case "ollama":
        return [
          { file: "winget", args: ["install", "-e", "--id", "Ollama.Ollama", ...WINGET_FLAGS] },
        ];
      case "ollama-start":
        return [{ file: ctx.ollama || "ollama", args: ["serve"], background: true }];
      case "answer-model":
        return [
          { file: ctx.ollama || "ollama", args: ["pull", ctx.model || DEFAULT_ANSWER_MODEL] },
        ];
      case "hinglish-libs": {
        const vpy = venvPython(hinglishVenv, platform);
        const steps = [];
        if (!fsImpl.existsSync(vpy))
          steps.push({ file: ctx.python || "python", args: ["-m", "venv", hinglishVenv] });
        steps.push({
          file: vpy,
          args: [
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            requirementsFile || "requirements.txt",
          ],
        });
        return steps;
      }
      case "hinglish-model":
        return [
          {
            file: venvPython(hinglishVenv, platform),
            args: [
              "-c",
              `from huggingface_hub import snapshot_download; snapshot_download('${HINGLISH_MODEL_REPO}')`,
            ],
          },
        ];
      default:
        return null;
    }
  }

  function runStep(step, onLine, dryRun) {
    if (dryRun) {
      onLine(`[dry run] would run: ${formatCommand(step)}`);
      return Promise.resolve({ ok: true, code: 0 });
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(step.file, step.args, {
          windowsHide: true,
          shell: false,
          detached: !!step.background,
          stdio: step.background ? "ignore" : ["ignore", "pipe", "pipe"],
          env: { ...env, PYTHONUNBUFFERED: "1", PIP_NO_INPUT: "1" },
        });
      } catch (error) {
        resolve({ ok: false, code: -1, error: error.message });
        return;
      }
      if (step.background) {
        child.on?.("error", () => {});
        child.unref?.();
        resolve({ ok: true, code: 0 });
        return;
      }
      const pump = (stream) => {
        let buf = "";
        stream?.setEncoding?.("utf8");
        stream?.on?.("data", (chunk) => {
          buf += chunk;
          const parts = buf.split(/\r\n|\r|\n/);
          buf = parts.pop();
          for (const p of parts) if (p.trim()) onLine(p);
        });
        stream?.on?.("end", () => buf.trim() && onLine(buf));
      };
      pump(child.stdout);
      pump(child.stderr);
      child.on("error", (error) => resolve({ ok: false, code: -1, error: error.message }));
      child.on("close", (code) => resolve({ ok: code === 0, code }));
    });
  }

  let busy = false;

  /**
   * Install one item. onEvent receives { line } and { progress } (0-100).
   * Returns { success, code?, error? }.
   */
  async function install(id, { onEvent = () => {}, dryRun = dryRunDefault, model } = {}) {
    if (busy) return { success: false, error: "Another install is still running" };
    let ctx = { model };
    let stepsId = id;
    if (id === "ollama" || id === "answer-model") {
      const ollama = findOllama(probe);
      ctx.ollama = ollama || "ollama";
      if (id === "ollama" && ollama) stepsId = "ollama-start";
    }
    if (id === "hinglish-libs") {
      const python = await findPython(probe);
      if (!python || python.tooOld) return { success: false, error: "Install Python first" };
      ctx.python = python.path;
      if (!requirementsFile || !fsImpl.existsSync(requirementsFile))
        return { success: false, error: "The Hinglish helper files are missing from this install" };
    }
    const steps = installSteps(stepsId, ctx);
    if (!steps) return { success: false, error: "Unknown item" };

    busy = true;
    try {
      for (let i = 0; i < steps.length; i++) {
        const base = (i / steps.length) * 100;
        const span = 100 / steps.length;
        onEvent({ line: `> ${formatCommand(steps[i])}`, progress: Math.round(base) });
        const result = await runStep(
          steps[i],
          (line) => {
            const pct = /(\d{1,3})(?:\.\d+)?\s?%/.exec(line);
            const progress = pct
              ? Math.round(base + (Math.min(100, +pct[1]) / 100) * span)
              : undefined;
            onEvent(progress === undefined ? { line } : { line, progress });
          },
          dryRun
        );
        if (!result.ok) {
          return {
            success: false,
            code: result.code,
            error: result.error || `Exited with code ${result.code}`,
          };
        }
      }
      if (stepsId === "ollama-start" && !dryRun) {
        // Give the server a few seconds to come up before the recheck.
        for (let i = 0; i < 10 && !(await listOllamaTags(fetchImpl)); i++) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      onEvent({ progress: 100 });
      return { success: true };
    } finally {
      busy = false;
    }
  }

  return { check, install, installSteps, hinglishVenv };
}

module.exports = {
  DEFAULT_ANSWER_MODEL,
  HINGLISH_MODEL_REPO,
  createRequirements,
  findPython,
  findOllama,
  pythonCandidates,
  parsePythonVersion,
  isSupportedPython,
  hasModel,
  formatCommand,
};

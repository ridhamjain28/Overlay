// Overlay: main-process IPC for the parts that need secrets or OS access.
//
//   overlay-answer-sources-status  -> which answer sources are usable now
//   overlay-ollama-models          -> model names pulled in the local Ollama
//   overlay-answer-stream-start    -> stream an answer from OpenClaw or Gemini
//   overlay-answer-stream-cancel   -> stop that stream
//   overlay-system-action          -> run one allowlisted laptop action
//   overlay-command-parse          -> turn speech/text into a Command-mode intent
//   overlay-command-execute        -> run one Command-mode action (confirm-gated)
//   overlay-command-orchestrate    -> plan and run one command (chat and voice)
//   overlay-command-cancel         -> abort an in-flight compose/write
//   overlay-set-command-mode-prefs -> enable flag and auto-run trusted actions
//   overlay-requirements-check     -> first-run checklist (what this PC still needs)
//   overlay-requirements-install   -> install one checklist item, hidden, with live output
//   overlay-hinglish-status        -> is the Hinglish speech server ready
//   overlay-hinglish-ensure        -> start it (hidden) if it is installed
//   overlay-hinglish-transcribe    -> turn one recording into Hinglish text
//   overlay-set-keep-assistant-on-top -> "Keep on top of other apps" for the answer panel
//   overlay-set-chat-context-length -> how much of a chat the local model keeps in view
//   overlay-chat-context-window    -> the window the local Ollama model actually loaded
//   overlay-memory-recall/remember/clear -> long-term chat memory in the app database
//
// Tokens (OPENCLAW_TOKEN, GEMINI_API_KEY, TAVILY_API_KEY) stay in this
// process; the renderer only ever sees answer text.

const path = require("path");
const fs = require("fs");
const { URL, fileURLToPath } = require("url");
const { execFile } = require("child_process");
let electronSafeStorage;
let electronClipboard;
try {
  ({ safeStorage: electronSafeStorage, clipboard: electronClipboard } = require("electron"));
} catch {
  electronSafeStorage = undefined;
  electronClipboard = undefined;
}
const { DEV_SERVER_URL } = require("../devServerManager");
const {
  streamOpenClaw,
  streamGemini,
  getAnswerSourcesStatus,
  listOllamaModels,
} = require("./answerSources");
const { createSystemActions } = require("./systemActions");
const {
  parseIntent,
  parseIntentHeuristic,
  shouldUseLlm,
  createIntentCompleter,
  createCommandDispatcher,
  createOrchestrator,
} = require("./commandMode");
const { createComposeCompleter } = require("./commandMode/composeClient");
const { queryWindowsSearch } = require("./commandMode/findPath");
const appSkills = require("./appSkillsService");
const customSkillsService = require("./customSkillsService");
const { listLocalSkills, readSkill } = require("./appSkillStore");
const { searchExamples, readAll, deleteExample, recordExample } = require("./learnedStore");
const { createDailyCounter, setDefaultSearchCounter } = require("./webSearch");
const { createRequirements } = require("./requirements");
const { createHinglishServer } = require("./hinglishServer");
const {
  chatContextTarget,
  normalizeChatContextSetting,
  ollamaLoadedContext,
  setChatContextSetting,
  resolveOllamaNumCtx,
  ensureOllamaModelContext,
  warmupOllamaModels,
  isOllamaCompatibleUrl,
} = require("./chatContext");
const { createChatMemoryStore } = require("./chatMemoryStore");
const { detectHardware } = require("./hardwareProfile");
const { selectLocalModel, recommendPull } = require("./modelAutoSelect");
const { generateDiagnosticReport } = require("./diagnosticReport");

// Model tags look like qwen3.5:4b-q4_K_M; refuse anything that could read as a flag.
const MODEL_TAG = /^[A-Za-z0-9][\w.:/-]{0,120}$/;

function findHinglishRequirements() {
  const candidates = [
    ...(process.resourcesPath
      ? [path.join(process.resourcesPath, "hinglish-asr", "requirements.txt")]
      : []),
    path.join(__dirname, "..", "..", "..", "hinglish-asr", "requirements.txt"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function findHinglishServerScript() {
  const candidates = [
    ...(process.resourcesPath
      ? [path.join(process.resourcesPath, "hinglish-asr", "server.py")]
      : []),
    path.join(__dirname, "..", "..", "..", "hinglish-asr", "server.py"),
  ];
  return candidates.filter((p) => fs.existsSync(p));
}

// Largest recording accepted for the Hinglish server (about an hour of WAV).
const MAX_HINGLISH_AUDIO_BYTES = 200 * 1024 * 1024;

function toAudioBuffer(audio) {
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (ArrayBuffer.isView(audio))
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  return null;
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    if (options?.detached) child.unref?.();
  });
}

function findNircmd() {
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, "bin", "nircmd.exe")] : []),
    path.join(__dirname, "..", "..", "..", "resources", "bin", "nircmd.exe"),
  ];
  return (
    candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) || null
  );
}

function showGuideHighlight(BrowserWindow, bounds) {
  if (!bounds || process.platform !== "win32" || !BrowserWindow) return;
  const pad = 4;
  const x = Math.round(Number(bounds.x) || 0) - pad;
  const y = Math.round(Number(bounds.y) || 0) - pad;
  const width = Math.max(8, Math.round(Number(bounds.w) || 0) + pad * 2);
  const height = Math.max(8, Math.round(Number(bounds.h) || 0) + pad * 2);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, "screen-saver");
  } catch {
    // Older Electron builds may not support the level or forward flag.
  }
  const html =
    "<!doctype html><html><body style=\"margin:0;background:transparent\">" +
    "<div style=\"box-sizing:border-box;width:100%;height:100%;border:3px solid #ff5a36;" +
    "border-radius:6px;box-shadow:0 0 0 2px rgba(255,255,255,.7),0 0 12px rgba(255,90,54,.8)\">" +
    "</div></body></html>";
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, 4000);
}

function normalizeFsPath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function createAssertTrustedSender({
  app,
  windowManager,
  devServerUrl = DEV_SERVER_URL,
  nodeEnv,
} = {}) {
  let devOrigin = "";
  let devAltOrigin = "";
  try {
    const u = new URL(devServerUrl);
    devOrigin = u.origin;
    if (u.hostname === "localhost") {
      devAltOrigin = `${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ""}`;
    } else if (u.hostname === "127.0.0.1") {
      devAltOrigin = `${u.protocol}//localhost${u.port ? `:${u.port}` : ""}`;
    }
  } catch {
    devOrigin = "";
  }

  return function assertTrustedSender(event) {
    if (!event || !event.sender || !event.senderFrame) {
      throw new Error("Untrusted IPC sender: missing sender or senderFrame");
    }

    const frameUrl = String(event.senderFrame.url || "").trim();
    if (!frameUrl) {
      throw new Error("Untrusted IPC sender: missing senderFrame URL");
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(frameUrl);
    } catch {
      throw new Error("Untrusted IPC sender: invalid senderFrame URL");
    }

    const isDev = (nodeEnv ?? process.env.NODE_ENV) === "development";
    let originTrusted = false;

    if (parsedUrl.protocol === "file:") {
      const appPath = typeof app?.getAppPath === "function" ? app.getAppPath() : "";
      if (appPath) {
        const expectedHtmlPath = normalizeFsPath(path.join(appPath, "src", "dist", "index.html"));
        let actualHtmlPath = "";
        try {
          const baseFileUrl = new URL(parsedUrl.href);
          baseFileUrl.search = "";
          baseFileUrl.hash = "";
          actualHtmlPath = normalizeFsPath(fileURLToPath(baseFileUrl));
        } catch {
          actualHtmlPath = "";
        }
        if (actualHtmlPath && actualHtmlPath === expectedHtmlPath) {
          originTrusted = true;
        }
      }
    } else if (
      isDev &&
      (parsedUrl.origin === devOrigin || (devAltOrigin && parsedUrl.origin === devAltOrigin))
    ) {
      originTrusted = true;
    }

    if (!originTrusted) {
      throw new Error(`Untrusted IPC sender origin: ${parsedUrl.origin || parsedUrl.protocol}`);
    }

    const senderId = event.sender.id;
    const candidateWindows = [
      windowManager?.mainWindow,
      windowManager?.controlPanelWindow,
      windowManager?.settingsWindow,
    ];
    const trustedIds = new Set();
    for (const win of candidateWindows) {
      if (!win) continue;
      if (typeof win.isDestroyed === "function" && win.isDestroyed()) continue;
      const wcId = win.webContents?.id;
      if (wcId !== undefined && wcId !== null) {
        trustedIds.add(wcId);
      }
    }

    if (!trustedIds.has(senderId)) {
      throw new Error("Untrusted IPC sender window");
    }
  };
}

function registerOverlayIpc({
  ipcMain,
  shell,
  dialog,
  app,
  BrowserWindow,
  debugLogger,
  windowManager,
  getDatabase,
  googleCalendarManager,
  microsoftCalendarManager,
  databaseManager,
  clipboardManager,
  safeStorage: injectedSafeStorage,
  clipboard: injectedClipboard,
  devServerUrl,
  nodeEnv,
}) {
  const activeSafeStorage =
    injectedSafeStorage !== undefined ? injectedSafeStorage : electronSafeStorage;
  const activeClipboard =
    injectedClipboard !== undefined ? injectedClipboard : electronClipboard;
  const assertTrustedSender = createAssertTrustedSender({
    app,
    windowManager,
    devServerUrl,
    nodeEnv,
  });
  let commandModePrefs = { enabled: false, autoRunTrusted: false, autoSaveCreatedItems: true };
  const skillsDir = appSkills.skillsDirFor(app);
  const activeStreams = new Map(); // `${senderId}:${requestId}` -> AbortController

  ipcMain.on("overlay-set-keep-assistant-on-top", (_event, enabled) => {
    windowManager?.setKeepAssistantOnTop?.(enabled === true);
  });
  setDefaultSearchCounter(
    createDailyCounter({
      filePath: path.join(app.getPath("userData"), "overlay-search-usage.json"),
    })
  );

  ipcMain.handle("overlay-ollama-models", async () => listOllamaModels());

  ipcMain.handle("overlay-hardware-profile", async () => detectHardware());

  ipcMain.handle("overlay-recommend-model", async (_event, opts = {}) => {
    const hardware = await detectHardware();
    const installed = Array.isArray(opts?.installed) ? opts.installed : await listOllamaModels();
    const current = typeof opts?.current === "string" ? opts.current : "";
    const autoSelect = opts?.autoSelect !== false;
    const picked = selectLocalModel({
      installed: installed || [],
      hardware,
      current,
      autoSelect,
    });
    return {
      ...picked,
      hardware,
      recommendedPull: picked.recommendedPull || recommendPull(hardware),
    };
  });

  let chatContextSetting = "auto";
  ipcMain.on("overlay-set-chat-context-length", (_event, value) => {
    chatContextSetting = normalizeChatContextSetting(value);
    setChatContextSetting(chatContextSetting);
  });

  ipcMain.handle("overlay-chat-context-window", async (_event, opts = {}) => {
    const model = typeof opts?.model === "string" ? opts.model : "";
    const baseUrl = typeof opts?.baseUrl === "string" ? opts.baseUrl : undefined;
    try {
      return { tokens: await ollamaLoadedContext({ baseUrl, model }) };
    } catch {
      return { tokens: null };
    }
  });

  let memoryStore = null;
  const memory = () => {
    if (memoryStore) return memoryStore;
    const db = typeof getDatabase === "function" ? getDatabase() : null;
    if (!db) return null;
    memoryStore = createChatMemoryStore(db);
    return memoryStore;
  };
  const memoryCall = (fn, fallback) => {
    try {
      const store = memory();
      return store ? fn(store) : fallback;
    } catch (error) {
      debugLogger?.warn?.("Chat memory unavailable", { error: error.message });
      return fallback;
    }
  };
  ipcMain.handle("overlay-ollama-ensure-context", async (_event, opts = {}) => {
    const model = typeof opts?.model === "string" ? opts.model : "";
    const baseUrl = typeof opts?.baseUrl === "string" ? opts.baseUrl : undefined;
    if (!model) return { ok: false, reason: "missing_model" };
    if (baseUrl && !isOllamaCompatibleUrl(baseUrl)) return { ok: false, reason: "not_ollama" };
    const numCtx = resolveOllamaNumCtx(chatContextSetting, require("os").totalmem());
    return ensureOllamaModelContext({ baseUrl, model, numCtx });
  });

  ipcMain.handle("overlay-ollama-warmup", async (_event, opts = {}) => {
    const baseUrl = typeof opts?.baseUrl === "string" ? opts.baseUrl : undefined;
    const models = Array.isArray(opts?.models) ? opts.models : [opts?.model].filter(Boolean);
    if (baseUrl && !isOllamaCompatibleUrl(baseUrl)) return { ok: false, reason: "not_ollama", results: [] };
    const numCtx = resolveOllamaNumCtx(chatContextSetting, require("os").totalmem());
    const results = await warmupOllamaModels({ baseUrl, models, numCtx });
    return { ok: results.some((r) => r && r.ok), results };
  });

  ipcMain.handle("overlay-memory-recall", async (_event, conversationKey, query) =>
    memoryCall((store) => store.recall(String(conversationKey || ""), String(query || "")), {
      facts: [],
      summary: null,
      related: [],
    })
  );
  ipcMain.handle("overlay-memory-remember", async (_event, conversationKey, payload = {}) =>
    memoryCall((store) => store.remember(String(conversationKey || ""), payload || {}), {
      savedFacts: 0,
      savedSummary: false,
    })
  );
  ipcMain.handle("overlay-memory-clear", async () =>
    memoryCall(
      (store) => {
        store.clear();
        return { success: true };
      },
      { success: false }
    )
  );

  ipcMain.handle("overlay-answer-sources-status", async () => {
    try {
      return await getAnswerSourcesStatus();
    } catch (error) {
      debugLogger?.warn?.("Overlay answer source status failed", { error: error.message });
      return {
        openclaw: { configured: false, reachable: false },
        gemini: { configured: false },
        ollamaSearch: { configured: false, usedToday: 0, dailyCap: 0 },
        tavily: { configured: false },
        searxng: { configured: false },
      };
    }
  });

  ipcMain.on("overlay-answer-stream-start", async (event, requestId, payload = {}) => {
    if (typeof requestId !== "string" || !requestId) return;
    const sender = event.sender;
    const key = `${sender.id}:${requestId}`;
    const controller = new AbortController();
    activeStreams.set(key, controller);
    const send = (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, { requestId, ...data });
    };
    const source =
      payload.source === "openclaw" ? "openclaw" : payload.source === "gemini" ? "gemini" : null;
    try {
      if (!source) throw new Error("Unknown answer source");
      const stream =
        source === "openclaw"
          ? streamOpenClaw({
              messages: payload.messages,
              user: payload.user,
              signal: controller.signal,
            })
          : streamGemini({ messages: payload.messages, signal: controller.signal });
      for await (const text of stream) {
        if (controller.signal.aborted) break;
        send("overlay-answer-stream-chunk", { text });
      }
      send("overlay-answer-stream-end", {});
    } catch (error) {
      if (controller.signal.aborted) send("overlay-answer-stream-end", {});
      else {
        debugLogger?.warn?.("Overlay answer stream failed", { source, error: error.message });
        send("overlay-answer-stream-error", { error: error.message });
      }
    } finally {
      activeStreams.delete(key);
    }
  });

  ipcMain.on("overlay-answer-stream-cancel", (event, requestId) => {
    const key = `${event.sender.id}:${requestId}`;
    activeStreams.get(key)?.abort();
    activeStreams.delete(key);
  });

  const riskPolicy = require("./commandMode/riskPolicy");

  let pendingVoiceConfirmation = null;

  const confirm = async (message, extra = {}) => {
    const parent = BrowserWindow?.getFocusedWindow?.() || undefined;
    const blocked = riskPolicy.isBlocked(extra?.step);
    const options = {
      type: "question",
      buttons: ["Cancel", "Allow"],
      defaultId: 1, // Gets focus, Enter activates Allow
      cancelId: 0,
      noLink: true,
      title: "Overlay",
      message: "Overlay wants to do this on your laptop",
      detail: String(message || ""),
      ...(blocked
        ? {}
        : {
            checkboxLabel: "Always allow",
            checkboxChecked: false,
          }),
    };

    const boxPromise = parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options);

    const voicePromise = new Promise((resolve) => {
      pendingVoiceConfirmation = resolve;
    });

    const result = await Promise.race([
      boxPromise,
      voicePromise.then((allow) => ({ response: allow ? 1 : 0, checkboxChecked: false })),
    ]);

    pendingVoiceConfirmation = null;

    const allowed = result.response === 1;
    if (allowed && result.checkboxChecked && extra?.step && !blocked) {
      try {
        riskPolicy.allowAction(app.getPath("userData"), extra.step);
      } catch (err) {
        debugLogger?.warn?.("Failed to persist always allow", { error: err?.message });
      }
    }
    return allowed;
  };

  const actions = createSystemActions({
    execFile: execFileAsync,
    openPath: (p) => shell.openPath(p),
    openExternal: (url) => openExternalSoon(url),
    confirm,
    picturesDir: app.getPath("pictures"),
    findNircmd,
  });

  const requirements = createRequirements({
    userDataDir: app.getPath("userData"),
    hinglishRequirementsFile: findHinglishRequirements(),
  });

  const hinglishDataDir = path.join(app.getPath("userData"), "hinglish-asr");
  const hinglish = createHinglishServer({
    venvDirs: [
      requirements.hinglishVenv,
      // A development checkout may have its own venv next to server.py.
      ...(app.isPackaged ? [] : [path.join(__dirname, "..", "..", "..", "hinglish-asr", ".venv")]),
    ],
    serverScripts: findHinglishServerScript(),
    logDir: (() => {
      try {
        fs.mkdirSync(hinglishDataDir, { recursive: true });
        return hinglishDataDir;
      } catch {
        return undefined;
      }
    })(),
    logger: debugLogger,
  });
  const stopHinglish = () => hinglish.shutdown();
  app.on("before-quit", stopHinglish);
  app.on("will-quit", stopHinglish);
  process.once("exit", stopHinglish);

  ipcMain.handle("overlay-hinglish-status", async () => hinglish.status());

  ipcMain.handle("overlay-hinglish-ensure", async () => {
    try {
      return await hinglish.ensure();
    } catch (error) {
      debugLogger?.warn?.("Hinglish speech server start failed", { error: error.message });
      return { state: "failed", ready: false };
    }
  });

  ipcMain.handle("overlay-hinglish-transcribe", async (_event, audio, opts = {}) => {
    const buffer = toAudioBuffer(audio);
    if (!buffer || buffer.length === 0 || buffer.length > MAX_HINGLISH_AUDIO_BYTES) {
      return { success: false, code: "BAD_AUDIO" };
    }
    const mimeType =
      typeof opts?.mimeType === "string" && /^audio\/[\w.+-]+/.test(opts.mimeType)
        ? opts.mimeType
        : "audio/webm";
    const prompt = typeof opts?.prompt === "string" ? opts.prompt : undefined;
    const result = await hinglish.transcribe(buffer, { mimeType, prompt });
    if (!result.success && result.code !== "NOT_READY") {
      debugLogger?.warn?.("Hinglish transcription failed", { code: result.code });
    }
    return result;
  });

  ipcMain.handle("overlay-requirements-check", async (_event, opts = {}) => {
    try {
      return await requirements.check({
        includeHinglish: !!opts?.includeHinglish,
        answerModel: MODEL_TAG.test(opts?.answerModel || "") ? opts.answerModel : undefined,
      });
    } catch (error) {
      debugLogger?.warn?.("Overlay requirements check failed", { error: error.message });
      return { items: [], error: error.message };
    }
  });

  ipcMain.handle("overlay-requirements-install", async (event, id, opts = {}) => {
    const sender = event.sender;
    const itemId = String(id || "");
    const result = await requirements.install(itemId, {
      model: MODEL_TAG.test(opts?.model || "") ? opts.model : undefined,
      contextLength: chatContextTarget(chatContextSetting, require("os").totalmem()),
      onEvent: (data) => {
        if (!sender.isDestroyed())
          sender.send("overlay-requirements-output", { id: itemId, ...data });
      },
    });
    debugLogger?.info?.("Overlay requirement install", { id: itemId, success: result.success });
    if (result.success && (itemId === "hinglish-libs" || itemId === "hinglish-model")) {
      hinglish.reset();
      hinglish.ensure().catch(() => {});
    }
    return result;
  });

  ipcMain.handle("overlay-system-action", async (_event, request) => {
    const result = await actions.perform(request);
    debugLogger?.info?.("Overlay system action", {
      action: request?.action,
      success: result.success,
      code: result.code,
    });
    return result;
  });

  ipcMain.on("overlay-set-command-mode-prefs", (_event, prefs = {}) => {
    commandModePrefs = {
      enabled: prefs?.enabled === true,
      autoRunTrusted: prefs?.autoRunTrusted === true,
      autoSaveCreatedItems:
        prefs?.autoSaveCreatedItems === undefined
          ? commandModePrefs.autoSaveCreatedItems !== false
          : prefs.autoSaveCreatedItems !== false,
    };
  });

  const commandConfirm = async (message, extra = {}) => {
    return confirm(message, extra);
  };

  const composeRuntime = { opts: {}, onProgress: null };
  let commandAbort = null;


  async function openExternalSoon(url) {
    const opened = Promise.resolve(shell.openExternal(url));
    opened.catch(() => {});
    await Promise.race([
      opened,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }

  async function focusNamedWindow(name) {
    const title = String(name || "").trim();
    if (!title || process.platform !== "win32") return;
    try {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate(" +
            JSON.stringify(title) +
            ")",
        ],
        { windowsHide: true, timeout: 4000 }
      );
    } catch {
      // Focus is best-effort; paste still goes to whatever is frontmost.
    }
  }

  async function listOpenWindows() {
    if (process.platform !== "win32") return { unsupported: true, windows: [] };
    try {
      const stdout = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }",
        ],
        { windowsHide: true, timeout: 4000 }
      );
      return String(stdout || "")
        .split(/\r?\n/)
        .map((title) => title.trim())
        .filter(Boolean)
        .map((title) => ({ title }));
    } catch {
      return [];
    }
  }

  function nircmdKeyCombo(combo) {
    return String(combo || "")
      .trim()
      .toLowerCase()
      .split("+")
      .map((part) => (part === "control" || part === "ctrl" ? "ctrl" : part === "cmd" || part === "meta" ? "win" : part))
      .filter(Boolean)
      .join("+");
  }

  function sendKeysWaitCombo(combo) {
    const parts = String(combo || "")
      .trim()
      .toLowerCase()
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    const mods = { control: "^", ctrl: "^", alt: "%", shift: "+", cmd: "^", meta: "^" };
    let keys = "";
    let last = "";
    for (const part of parts) {
      if (mods[part]) keys += mods[part];
      else last = part.length === 1 ? part : `{${part.toUpperCase()}}`;
    }
    return keys + last;
  }

  async function sendKeyCombo(combo) {
    const nircmd = findNircmd();
    const mapped = nircmdKeyCombo(combo);
    if (nircmd && mapped) {
      await execFileAsync(nircmd, ["sendkeypress", mapped], { windowsHide: true, timeout: 4000 });
      return;
    }
    if (process.platform !== "win32") {
      throw new Error("Keyboard shortcuts are not available");
    }
    const send = sendKeysWaitCombo(combo).replace(/'/g, "''");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.SendKeys]::SendWait('" +
          send +
          "')",
      ],
      { windowsHide: true, timeout: 4000 }
    );
  }

  const commandDispatcher = createCommandDispatcher({
    execFile: execFileAsync,
    openPath: (p) => shell.openPath(p),
    openExternal: (url) => openExternalSoon(url),
    confirm: commandConfirm,
    pasteText: async (text, options) => {
      if (!clipboardManager?.pasteText) throw new Error("Typing into apps is not available");
      return clipboardManager.pasteText(text, {
        restoreClipboard: true,
        silentAccessibilityCheck: true,
        ...options,
      });
    },
    showHighlight: (bounds) => showGuideHighlight(BrowserWindow, bounds),
    isEnabled: () => commandModePrefs.enabled === true,
    getAutoRunTrusted: () => commandModePrefs.autoRunTrusted === true,
    composeText: async (prompt, extra = {}) => {
      const completer = createComposeCompleter(composeRuntime.opts);
      return completer(prompt, extra);
    },
    focusApp: focusNamedWindow,
    sendKeys: sendKeyCombo,
    onProgress: (phase) => {
      try {
        composeRuntime.onProgress?.(phase);
      } catch {
        // ignore
      }
    },
    getAppSkill: (appId) => readSkill(skillsDir, appId),
    userDataDir: app.getPath("userData"),
    searchIndex:
      process.platform === "win32"
        ? (opts) => queryWindowsSearch(execFileAsync, opts)
        : undefined,
  });

  const { McpManager } = require("./mcp/mcpManager");
  const { validateConfig, hasStdioConfigChanged } = require("./mcp/mcpConfig");
  const { discoverExternalConfigs, importSelectedServers } = require("./mcp/mcpImporter");
  const galleryServers = require("./mcp/gallery.json");
  const { performOAuthFlow } = require("./mcp/mcpAuth");

  const mcpManager = new McpManager({
    appDataDir: app.getPath("appData"),
    userDataDir: app.getPath("userData"),
    openBrowser: (url) => openExternalSoon(url),
    safeStorage: activeSafeStorage,
  });
  mcpManager.init().catch((err) => {
    debugLogger?.warn?.("MCP manager init failed", { error: err?.message });
  });

  mcpManager.onStatus((statusObj) => {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const w of windows) {
        if (!w.isDestroyed()) {
          w.webContents.send("overlay-mcp-status", statusObj);
        }
      }
    } catch {}
  });

  const { createDecisionRouter } = require("./commandMode/decisionRouter");
  const decisionRouter = createDecisionRouter();

  const commandOrchestrator = createOrchestrator({
    userDataDir: app.getPath("userData"),
    parseHeuristic: (utterance) => {
      const skills = listLocalSkills(skillsDir).filter((skill) => skill && skill.enabled !== false);
      const learned = searchExamples(skillsDir, utterance, { k: 3 });
      return parseIntentHeuristic(utterance, { skills, learned });
    },
    shouldUseLlm,
    decideRoute: (utterance, routeOpts = {}) => {
      const mcpTools = routeOpts?.mcpTools || mcpManager.pickTopKTools(utterance, 8);
      return decisionRouter(utterance, { ...routeOpts, mcpTools });
    },
    parseIntent: async (text, options = {}) => {
      const completer = createIntentCompleter({
        parser: options?.parser === "cloud" ? "cloud" : "local",
        model: MODEL_TAG.test(options?.model || "") ? options.model : undefined,
        localBaseUrl: options?.localBaseUrl,
        cloudProvider: options?.cloudProvider,
      });
      const skills = listLocalSkills(skillsDir).filter((skill) => skill && skill.enabled !== false);
      const learned = searchExamples(skillsDir, text, { k: 3 });
      const mcpTools = options?.mcpTools || mcpManager.pickTopKTools(text, 8);
      return parseIntent(text, {
        llmComplete: completer,
        forceLlm: options?.forceLlm === true,
        skills,
        learned,
        mcpTools,
        signal: options?.signal,
      });
    },
    perform: (request, options = {}) =>
      commandDispatcher.perform(request, { ...options, allowWhenDisabled: true }),
    callMcpTool: (server, tool, args) => mcpManager.callTool(server, tool, args),
    confirm,
    riskPolicy,
    listWindows: listOpenWindows,
    focusWindow: (win) => focusNamedWindow(win?.title || win?.windowTitle || win),
    sendKeys: sendKeyCombo,
  });


  ipcMain.handle("overlay-command-parse", async (_event, payload = {}) => {
    const text = String(payload?.text || "");
    const completer = createIntentCompleter({
      parser: payload?.parser === "cloud" ? "cloud" : "local",
      model: MODEL_TAG.test(payload?.model || "") ? payload.model : undefined,
      localBaseUrl: payload?.localBaseUrl,
      cloudProvider: payload?.cloudProvider,
    });
    const skills = listLocalSkills(skillsDir).filter((skill) => skill && skill.enabled !== false);
    try {
      const learned = searchExamples(skillsDir, text, { k: 3 });
      const mcpTools = mcpManager.pickTopKTools(text, 8);
      const parsed = await parseIntent(text, { llmComplete: completer, skills, learned, mcpTools });
      if (parsed?.errorCode) {
        debugLogger?.warn?.("Command mode parse did not finish", {
          errorCode: parsed.errorCode,
          error: parsed.errorMessage,
        });
      }
      return parsed;
    } catch (error) {
      debugLogger?.warn?.("Command mode parse failed", { error: error?.message });
      return {
        ...parseIntentHeuristic(text, { skills }),
        errorCode: error?.code === "TIMEOUT" || error?.name === "AbortError" ? "TIMEOUT" : "PARSE_ERROR",
        errorMessage: String(error?.message || "parse failed"),
      };
    }
  });


  ipcMain.handle("overlay-command-orchestrate", async (event, payload = {}) => {
    const text = String(payload?.text || "");
    if (pendingVoiceConfirmation) {
      const lower = text.trim().toLowerCase();
      if (/^(yes|yeah|yep|allow|proceed|sure|ok|okay|haan|ha)\b/i.test(lower)) {
        pendingVoiceConfirmation(true);
        return { handled: true, success: true, message: "Allowed" };
      }
      if (/^(no|cancel|stop|don't|dont|nahi)\b/i.test(lower)) {
        pendingVoiceConfirmation(false);
        return { handled: true, success: false, message: "Cancelled" };
      }
    }
    if (commandAbort) {
      try { commandAbort.abort(); } catch { /* ignore */ }
    }
    const currentAbort = typeof AbortController === "function" ? new AbortController() : null;
    commandAbort = currentAbort;
    composeRuntime.opts = {
      parser: payload?.parser === "cloud" ? "cloud" : "local",
      model: MODEL_TAG.test(payload?.model || "") ? payload.model : undefined,
      localBaseUrl: payload?.localBaseUrl,
      cloudProvider: payload?.cloudProvider,
    };
    const currentProgress = (progressData) => {
      try {
        if (currentAbort?.signal?.aborted || event.sender.isDestroyed?.()) return;
        const p = typeof progressData === "string" ? { phase: progressData } : progressData;
        event.sender.send("overlay-command-progress", p);
      } catch {
        // ignore
      }
    };
    composeRuntime.onProgress = currentProgress;
    try {
      const result = await commandOrchestrator.orchestrate(text, {
        parser: composeRuntime.opts.parser,
        model: composeRuntime.opts.model,
        localBaseUrl: composeRuntime.opts.localBaseUrl,
        cloudProvider: composeRuntime.opts.cloudProvider,
        autoRunTrusted: payload?.autoRunTrusted === true || commandModePrefs.autoRunTrusted,
        autoSaveCreatedItems:
          payload?.autoSaveCreatedItems !== undefined
            ? payload.autoSaveCreatedItems !== false
            : commandModePrefs.autoSaveCreatedItems !== false,
        confirmed: payload?.confirmed === true,
        onProgress: currentProgress,
        signal: currentAbort?.signal,
      });
      debugLogger?.info?.("Overlay command orchestrator", {
        handled: result.handled,
        success: result.success,
        cancelled: result.cancelled === true,
        deduped: result.deduped === true,
        steps: (result.steps || []).map((step) => step.action),
      });
      try {
        if (!event.sender.isDestroyed?.()) {
          event.sender.send("overlay-command-progress", {
            phase: "done",
            code: result.cancelled
              ? "CANCELLED"
              : result.success
                ? "OK"
                : result.handled
                  ? "FAILED"
                  : "NONE",
          });
        }
      } catch {
        // ignore
      }
      return result;
    } finally {
      if (composeRuntime.onProgress === currentProgress) {
        composeRuntime.onProgress = null;
      }
      if (commandAbort === currentAbort) {
        commandAbort = null;
      }
    }
  });

  ipcMain.handle("overlay-command-execute", async (event, request = {}) => {
    if (commandAbort) {
      try { commandAbort.abort(); } catch { /* ignore */ }
    }
    const currentAbort = typeof AbortController === "function" ? new AbortController() : null;
    commandAbort = currentAbort;
    composeRuntime.opts = {
      parser: request?.parser === "cloud" ? "cloud" : "local",
      model: MODEL_TAG.test(request?.model || "") ? request.model : undefined,
      localBaseUrl: request?.localBaseUrl,
      cloudProvider: request?.cloudProvider,
    };
    const currentProgress = (phase) => {
      try {
        if (currentAbort?.signal?.aborted || event.sender.isDestroyed?.()) return;
        event.sender.send("overlay-command-progress", { phase });
      } catch {
        // ignore
      }
    };
    composeRuntime.onProgress = currentProgress;
    try {
      const result = await commandDispatcher.perform(
        { action: request?.action, args: request?.args || request, steps: request?.steps },
        {
          confirmed: request?.confirmed === true,
          autoRunTrusted: request?.autoRunTrusted === true || commandModePrefs.autoRunTrusted,
          signal: currentAbort?.signal,
        }
      );
      debugLogger?.info?.("Overlay command mode", {
        action: request?.action,
        success: result.success,
        code: result.code,
      });
      try {
        if (!event.sender.isDestroyed?.()) {
          event.sender.send("overlay-command-progress", { phase: "done", code: result.code });
        }
      } catch {
        // ignore
      }
      return result;
    } finally {
      if (composeRuntime.onProgress === currentProgress) {
        composeRuntime.onProgress = null;
      }
      if (commandAbort === currentAbort) {
        commandAbort = null;
      }
    }
  });

  ipcMain.handle("overlay-command-cancel", async () => {
    try {
      commandAbort?.abort();
    } catch {
      // ignore
    }
    return { ok: true };
  });

  // Feature B: check which third-party apps have OAuth credentials configured
  ipcMain.handle("overlay-app-configs", async () => {
    return {
      "google-calendar": Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID),
      "microsoft-calendar": Boolean(process.env.MICROSOFT_CALENDAR_CLIENT_ID),
    };
  });

  // Feature C: dictation intent detection and scheduling
  const { mightContainIntent } = require("../intents/intentDetector");
  const { extractIntent, intentBaseUrl } = require("../intents/intentExtractor");
  const { buildIcs } = require("../intents/icsWriter");
  const { ReminderScheduler } = require("../intents/reminderScheduler");

  let reminderScheduler = null;
  try {
    const db = getDatabase?.() || databaseManager?.db || null;
    if (db) {
      reminderScheduler = new ReminderScheduler(db);
      reminderScheduler.restorePendingReminders();
    }
  } catch {}

  // Fast synchronous check — no model, no network
  ipcMain.handle("overlay-intent-detect", (_event, text) => {
    if (typeof text !== "string") return false;
    return mightContainIntent(text);
  });

  // Local model call with 4s timeout
  ipcMain.handle("overlay-intent-extract", async (_event, text, opts) => {
    if (typeof text !== "string" || text.length > 2000) return null;
    try {
      return await extractIntent({ text, ollamaBase: intentBaseUrl(opts?.baseUrl) });
    } catch {
      return null;
    }
  });

  // Write .ics file and open with default calendar app
  ipcMain.handle("overlay-ics-open", async (_event, intentData) => {
    if (!intentData || typeof intentData !== "object") return { success: false };
    try {
      const icsContent = buildIcs({
        title: String(intentData.title || "Event").slice(0, 200),
        start: intentData.start,
        end: intentData.end || null,
        description: intentData.description || undefined,
      });
      const tmpDir = app.getPath("temp");
      const fileName = `overlay-event-${Date.now()}.ics`;
      const filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, icsContent, "utf8");
      await shell.openPath(filePath);
      return { success: true, filePath };
    } catch (error) {
      debugLogger?.warn?.("overlay-ics-open failed", { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Schedule a local reminder with a Windows/system notification
  ipcMain.handle("overlay-reminder-schedule", async (_event, reminderData) => {
    if (!reminderData || !reminderData.title || !reminderData.start) {
      return { success: false, error: "invalid_params" };
    }
    try {
      if (!reminderScheduler) {
        const db = getDatabase?.() || databaseManager?.db || null;
        if (db) reminderScheduler = new ReminderScheduler(db);
      }
      const scheduled = reminderScheduler?.schedule({
        title: reminderData.title,
        time: reminderData.start,
      });
      return { success: true, reminder: scheduled };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Create event in connected calendar (Google or Outlook) or fallback to .ics
  ipcMain.handle("overlay-calendar-event-create", async (_event, { target, event: eventData }) => {
    if (!eventData || !eventData.title || !eventData.start) {
      return { success: false, error: "invalid_params" };
    }
    try {
      if (target === "gcal" && googleCalendarManager?.isConnected()) {
        try {
          return await googleCalendarManager.createEvent(eventData);
        } catch (err) {
          if (err.code === "RECONNECT_NEEDED" || err.message === "reconnect_needed") {
            return { success: false, reconnectNeeded: true, provider: "google" };
          }
          throw err;
        }
      }
      if (target === "mcal" && microsoftCalendarManager?.isConnected()) {
        try {
          return await microsoftCalendarManager.createEvent(eventData);
        } catch (err) {
          if (err.code === "RECONNECT_NEEDED" || err.message === "reconnect_needed") {
            return { success: false, reconnectNeeded: true, provider: "microsoft" };
          }
          throw err;
        }
      }
      // Default / fallback: write .ics file and open
      const icsContent = buildIcs({
        title: String(eventData.title || "Event").slice(0, 200),
        start: eventData.start,
        end: eventData.end || null,
      });
      const tmpDir = app.getPath("temp");
      const fileName = `overlay-event-${Date.now()}.ics`;
      const filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, icsContent, "utf8");
      await shell.openPath(filePath);
      return { success: true, filePath, format: "ics" };
    } catch (error) {
      debugLogger?.warn?.("overlay-calendar-event-create failed", { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // Save to-do as an Overlay note titled "To-do"
  ipcMain.handle("overlay-todo-create", async (_event, todoData) => {
    try {
      const title = "To-do";
      const content = String(todoData?.title || todoData?.text || "").trim();
      if (!content) return { success: false, error: "empty_content" };
      const db = databaseManager || (getDatabase ? { db: getDatabase() } : null);
      if (db?.saveNote) {
        const result = db.saveNote(title, content, "personal");
        return { success: true, note: result?.note };
      }
      return { success: false, error: "database_not_available" };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });


  function sendSkillProgress(event, payload) {
    try {
      event.sender.send("overlay-apps-scan-progress", payload);
    } catch {
      // The window may have gone away.
    }
  }

  let activeAppScanPromise = null;
  ipcMain.handle("overlay-apps-scan", async (event) => {
    if (activeAppScanPromise) {
      return activeAppScanPromise;
    }
    activeAppScanPromise = appSkills
      .rescanAndBuildPack({
        baseDir: skillsDir,
        scanOpts: {
          readShortcutLink:
            typeof shell.readShortcutLink === "function"
              ? (file) => shell.readShortcutLink(file)
              : undefined,
        },
        onProgress: (progress) => sendSkillProgress(event, progress),
      })
      .then((result) => result.scanResult)
      .finally(() => {
        activeAppScanPromise = null;
      });
    return activeAppScanPromise;
  });

  ipcMain.handle("overlay-apps-list", async () => {
    return appSkills.listSkills(skillsDir);
  });

  ipcMain.handle("overlay-apps-get-summary", async () => {
    return appSkills.getSummary(skillsDir);
  });

  ipcMain.handle("overlay-apps-set-enabled", async (_event, payload = {}) => {
    appSkills.setEnabled(skillsDir, {
      appId: String(payload.appId || ""),
      actionId: payload.actionId,
      enabled: payload.enabled === true,
    });
  });

  ipcMain.handle("overlay-apps-test", async (_event, payload = {}) => {
    return appSkills.testSkillAction({
      skill: readSkill(skillsDir, String(payload.appId || "")),
      actionId: payload.actionId,
      params: payload.params || {},
      perform: (request, options) => commandDispatcher.perform(request, options),
    });
  });

  ipcMain.handle("overlay-apps-learned-list", async () => {
    return readAll(skillsDir);
  });

  ipcMain.handle("overlay-apps-learned-delete", async (_event, id) => {
    deleteExample(skillsDir, String(id || ""));
  });

  ipcMain.handle("overlay-apps-learned-record", async (_event, entry = {}) => {
    return recordExample(skillsDir, entry);
  });

  ipcMain.handle("overlay-apps-custom-get", async () => {
    return customSkillsService.getCustomSkills(skillsDir);
  });

  ipcMain.handle("overlay-apps-custom-save", async (_event, text) => {
    return customSkillsService.saveCustomSkills(skillsDir, text);
  });

  ipcMain.handle("overlay-apps-custom-validate", async (_event, text) => {
    return customSkillsService.validateCustomSkillsText(text);
  });

  ipcMain.handle("overlay-apps-custom-open-file", async () => {
    return customSkillsService.openCustomFile(skillsDir, shell);
  });

  // MCP Connectors IPC
  ipcMain.handle("overlay-mcp-list", async (event) => {
    assertTrustedSender(event);
    return mcpManager.listServers();
  });

  ipcMain.handle("overlay-mcp-add", async (event, { name, cfg } = {}) => {
    assertTrustedSender(event);
    return mcpManager.configStore.addServer(name, cfg, { authStore: mcpManager.authStore });
  });

  ipcMain.handle("overlay-mcp-remove", async (event, { name } = {}) => {
    assertTrustedSender(event);
    await mcpManager.disconnect(name).catch(() => {});
    mcpManager.authStore?.removeTokens?.(name);
    mcpManager.authStore?.removeEnvSecrets?.(name);
    return mcpManager.configStore.removeServer(name);
  });

  ipcMain.handle("overlay-mcp-connect", async (event, { name } = {}) => {
    assertTrustedSender(event);
    try {
      await mcpManager.connect(name);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("overlay-mcp-disconnect", async (event, { name } = {}) => {
    assertTrustedSender(event);
    await mcpManager.disconnect(name);
    return { ok: true };
  });

  ipcMain.handle("overlay-mcp-auth", async (event, { name } = {}) => {
    assertTrustedSender(event);
    const config = mcpManager.configStore.read();
    const serverCfg = config.servers?.[name];
    if (!serverCfg || !serverCfg.url) {
      return { ok: false, error: "Server URL not found" };
    }
    try {
      await performOAuthFlow(name, serverCfg.url, {
        authStore: mcpManager.authStore,
        openBrowser: (url) => openExternalSoon(url),
      });
      await mcpManager.connect(name).catch(() => {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("overlay-mcp-tools", async (event, { name } = {}) => {
    assertTrustedSender(event);
    const tools = await mcpManager.listToolsForServer(name);
    return tools.map((t) => ({
      ...t,
      enabled: mcpManager.isToolEnabled(name, t.name),
    }));
  });

  ipcMain.handle("overlay-mcp-set-tool-enabled", async (event, { name, tool, on } = {}) => {
    assertTrustedSender(event);
    mcpManager.setToolEnabled(name, tool, on === true);
    return { ok: true };
  });

  ipcMain.handle("overlay-mcp-config-get", async (event) => {
    assertTrustedSender(event);
    return mcpManager.configStore.readMasked();
  });

  ipcMain.handle("overlay-mcp-config-save", async (event, { text } = {}) => {
    assertTrustedSender(event);
    const validation = validateConfig(text);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const current = mcpManager.configStore.read();
    const diff = hasStdioConfigChanged(current.servers, validation.servers);
    if (diff.changed) {
      if (!dialog || typeof dialog.showMessageBox !== "function") {
        return { ok: false, errors: ["Confirmation dialog is unavailable"] };
      }
      const parent =
        BrowserWindow?.getFocusedWindow?.() ||
        windowManager?.controlPanelWindow ||
        windowManager?.mainWindow ||
        undefined;
      const dialogParent =
        parent && (typeof parent.isDestroyed !== "function" || !parent.isDestroyed())
          ? parent
          : undefined;
      const boxOptions = {
        type: "warning",
        buttons: ["Cancel", "Save Changes"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: "Confirm MCP Configuration Change",
        message: `Save MCP changes for "${diff.serverName}"?`,
        detail: `The stdio ${diff.reason || "configuration"} (command, args, or env) was modified. Changes affect what local commands Overlay launches.`,
      };
      const boxRes = dialogParent
        ? await dialog.showMessageBox(dialogParent, boxOptions)
        : await dialog.showMessageBox(boxOptions);
      if (boxRes?.response !== 1) {
        return { ok: false, cancelled: true, errors: ["Save cancelled by user"] };
      }
    }
    return mcpManager.configStore.saveWithSecrets(text, mcpManager.authStore);
  });

  ipcMain.handle("overlay-mcp-test", async (event, { name } = {}) => {
    assertTrustedSender(event);
    try {
      await mcpManager.connect(name);
      const tools = await mcpManager.listToolsForServer(name);
      return {
        ok: true,
        tools: tools.map((t) => ({
          ...t,
          enabled: mcpManager.isToolEnabled(name, t.name),
        })),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("overlay-mcp-gallery", async (event) => {
    assertTrustedSender(event);
    return galleryServers;
  });

  ipcMain.handle("overlay-mcp-import-discover", async (event) => {
    assertTrustedSender(event);
    return discoverExternalConfigs();
  });

  ipcMain.handle("overlay-mcp-import-servers", async (event, payload = {}) => {
    assertTrustedSender(event);
    const selectedIds = payload?.selectedIds ?? payload?.selected ?? [];
    return importSelectedServers(selectedIds, {
      mcpConfigStore: mcpManager.configStore,
      authStore: mcpManager.authStore,
      envImportChoices: payload?.envImportChoices || {},
      importEnvValues: payload?.importEnvValues === true,
    });
  });

  ipcMain.handle("overlay-mcp-permissions-list", async (event) => {
    assertTrustedSender(event);
    return mcpManager.listPermissions();
  });

  ipcMain.handle("overlay-mcp-permissions-revoke", async (event, { key } = {}) => {
    assertTrustedSender(event);
    return { ok: mcpManager.revokePermission(key) };
  });

  // System Diagnostics IPC
  ipcMain.handle("overlay-diagnostics-get", async (event) => {
    assertTrustedSender(event);
    return generateDiagnosticReport({
      mcpManager,
      debugLogger,
      app,
    });
  });

  ipcMain.handle("overlay-diagnostics-copy", async (event) => {
    assertTrustedSender(event);
    try {
      const report = await generateDiagnosticReport({
        mcpManager,
        debugLogger,
        app,
      });
      if (activeClipboard && typeof activeClipboard.writeText === "function") {
        activeClipboard.writeText(report);
      }
      return { ok: true, report };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  return { assertTrustedSender, mcpManager };
}

module.exports = { registerOverlayIpc, createAssertTrustedSender };

// Overlay: main-process IPC for the parts that need secrets or OS access.
//
//   overlay-answer-sources-status  -> which answer sources are usable now
//   overlay-ollama-models          -> model names pulled in the local Ollama
//   overlay-answer-stream-start    -> stream an answer from OpenClaw or Gemini
//   overlay-answer-stream-cancel   -> stop that stream
//   overlay-system-action          -> run one allowlisted laptop action
//   overlay-command-parse          -> turn speech/text into a Command-mode intent
//   overlay-command-execute        -> run one Command-mode action (confirm-gated)
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
const { execFile } = require("child_process");
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
  createIntentCompleter,
  createCommandDispatcher,
} = require("./commandMode");
const { createComposeCompleter } = require("./commandMode/composeClient");
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
}) {
  let commandModePrefs = { enabled: false, autoRunTrusted: false };
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

  const confirm = async (message) => {
    const parent = BrowserWindow?.getFocusedWindow?.() || undefined;
    const options = {
      type: "question",
      buttons: ["Cancel", "Allow"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Overlay",
      message: "Overlay wants to do this on your laptop",
      detail: message,
    };
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  };

  const actions = createSystemActions({
    execFile: execFileAsync,
    openPath: (p) => shell.openPath(p),
    openExternal: (url) => shell.openExternal(url),
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
    };
  });

  const commandConfirm = async (message) => {
    const parent = BrowserWindow?.getFocusedWindow?.() || undefined;
    const options = {
      type: "question",
      buttons: ["Cancel", "Allow"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Overlay Command mode",
      message: "Overlay wants to run this command on your laptop",
      detail: String(message || ""),
    };
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  };

  const composeRuntime = { opts: {}, onProgress: null };
  let commandAbort = null;

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

  const commandDispatcher = createCommandDispatcher({
    execFile: execFileAsync,
    openPath: (p) => shell.openPath(p),
    openExternal: (url) => shell.openExternal(url),
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
    onProgress: (phase) => {
      try {
        composeRuntime.onProgress?.(phase);
      } catch {
        // ignore
      }
    },
    getAppSkill: (appId) => readSkill(skillsDir, appId),
    openExternal: (url) => shell.openExternal(url),
  });

  ipcMain.handle("overlay-command-parse", async (_event, payload = {}) => {
    const text = String(payload?.text || "");
    const completer = createIntentCompleter({
      parser: payload?.parser === "cloud" ? "cloud" : "local",
      model: MODEL_TAG.test(payload?.model || "") ? payload.model : undefined,
      localBaseUrl: payload?.localBaseUrl,
      cloudProvider: payload?.cloudProvider,
    });
    try {
      const skills = listLocalSkills(skillsDir).filter((skill) => skill && skill.enabled !== false);
      const learned = searchExamples(skillsDir, text, { k: 3 });
      const parsed = await parseIntent(text, { llmComplete: completer, skills, learned });
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
        ...parseIntentHeuristic(text, { skills: listLocalSkills(skillsDir) }),
        errorCode: error?.code === "TIMEOUT" || error?.name === "AbortError" ? "TIMEOUT" : "PARSE_ERROR",
        errorMessage: String(error?.message || "parse failed"),
      };
    }
  });

  ipcMain.handle("overlay-command-execute", async (event, request = {}) => {
    if (commandAbort) {
      try { commandAbort.abort(); } catch { /* ignore */ }
    }
    commandAbort = typeof AbortController === "function" ? new AbortController() : null;
    composeRuntime.opts = {
      parser: request?.parser === "cloud" ? "cloud" : "local",
      model: MODEL_TAG.test(request?.model || "") ? request.model : undefined,
      localBaseUrl: request?.localBaseUrl,
      cloudProvider: request?.cloudProvider,
    };
    composeRuntime.onProgress = (phase) => {
      try {
        event.sender.send("overlay-command-progress", { phase });
      } catch {
        // ignore
      }
    };
    try {
      const result = await commandDispatcher.perform(
        { action: request?.action, args: request?.args || request, steps: request?.steps },
        {
          confirmed: request?.confirmed === true,
          autoRunTrusted: request?.autoRunTrusted === true || commandModePrefs.autoRunTrusted,
          signal: commandAbort?.signal,
        }
      );
      debugLogger?.info?.("Overlay command mode", {
        action: request?.action,
        success: result.success,
        code: result.code,
      });
      try {
        event.sender.send("overlay-command-progress", { phase: "done", code: result.code });
      } catch {
        // ignore
      }
      return result;
    } finally {
      composeRuntime.onProgress = null;
      commandAbort = null;
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

  ipcMain.handle("overlay-apps-scan", async (event) => {
    const result = await appSkills.rescanAndBuildPack({
      baseDir: skillsDir,
      scanOpts: {
        readShortcutLink: typeof shell.readShortcutLink === "function"
          ? (file) => shell.readShortcutLink(file)
          : undefined,
      },
      onProgress: (progress) => sendSkillProgress(event, progress),
    });
    return result.scanResult;
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


}

module.exports = { registerOverlayIpc };

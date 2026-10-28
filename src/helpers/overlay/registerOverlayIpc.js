// Overlay: main-process IPC for the parts that need secrets or OS access.
//
//   overlay-answer-sources-status  -> which answer sources are usable now
//   overlay-ollama-models          -> model names pulled in the local Ollama
//   overlay-answer-stream-start    -> stream an answer from OpenClaw or Gemini
//   overlay-answer-stream-cancel   -> stop that stream
//   overlay-system-action          -> run one allowlisted laptop action
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
const { createDailyCounter, setDefaultSearchCounter } = require("./webSearch");

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

function registerOverlayIpc({ ipcMain, shell, dialog, app, BrowserWindow, debugLogger }) {
  const activeStreams = new Map(); // `${senderId}:${requestId}` -> AbortController
  setDefaultSearchCounter(
    createDailyCounter({
      filePath: path.join(app.getPath("userData"), "overlay-search-usage.json"),
    })
  );

  ipcMain.handle("overlay-ollama-models", async () => listOllamaModels());

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

  ipcMain.handle("overlay-system-action", async (_event, request) => {
    const result = await actions.perform(request);
    debugLogger?.info?.("Overlay system action", {
      action: request?.action,
      success: result.success,
      code: result.code,
    });
    return result;
  });
}

module.exports = { registerOverlayIpc };

const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function mountAssistantPanel(t, { open = true, pendingCommand = null, orchestrate } = {}) {
  let root;
  let progressCb = null;
  const cancelledCalls = [];
  const closeCalls = [];
  const docListeners = new Map();

  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__assistantPanelTestMocks;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        overlayCommandOrchestrate: orchestrate,
        overlayCommandCancel: async () => {
          cancelledCalls.push(Date.now());
          return { ok: true };
        },
        onOverlayCommandProgress: (cb) => {
          progressCb = cb;
          return () => {
            progressCb = null;
          };
        },
      },
    },
  });

  const container = installInteractiveDom(t);
  const origAdd = globalThis.document.addEventListener.bind(globalThis.document);
  const origRemove = globalThis.document.removeEventListener.bind(globalThis.document);
  globalThis.document.addEventListener = (type, listener) => {
    const set = docListeners.get(type) ?? new Set();
    set.add(listener);
    docListeners.set(type, set);
    origAdd(type, listener);
  };
  globalThis.document.removeEventListener = (type, listener) => {
    docListeners.get(type)?.delete(listener);
    origRemove(type, listener);
  };

  globalThis.__assistantPanelTestMocks = {
    cancelStreamCalls: 0,
    messages: [],
    setMessages: null,
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-panel-command-test-",
    mockModules: {
      "/useChatPersistence": `
        import { useState } from "react";
        export const useChatPersistence = () => {
          const [messages, setMessages] = useState([]);
          const [conversationId, setConversationId] = useState(1);
          globalThis.__assistantPanelTestMocks.setMessages = setMessages;
          return {
            conversationId,
            messages,
            setMessages,
            createConversation: async () => 1,
            saveUserMessage: async () => {},
            saveAssistantMessage: async () => {},
            loadConversation: async () => true,
            handleNewChat: () => setMessages([]),
            getSessionVersion: () => 1,
          };
        };
      `,
      "/useChatStreaming": `
        export const useChatStreaming = () => ({
          agentState: "idle",
          activeToolName: null,
          toolStatus: "",
          sendToAI: async () => {},
          cancelStream: () => {
            globalThis.__assistantPanelTestMocks.cancelStreamCalls += 1;
          },
        });
      `,
      "/useWindowDrag": `
        export const useWindowDrag = () => ({
          handleMouseDown: () => {},
          handleMouseUp: () => {},
        });
      `,
      "/stores/settingsStore": `
        export const useSettingsStore = (selector) => selector({
          voiceAgentKey: "Alt+Space",
          commandModeEnabled: true,
          commandModeAutoRunTrusted: false,
          autoSaveCreatedItems: true,
          commandModeParser: "local",
          chatAgentModel: "qwen3:8b",
          chatAgentRemoteUrl: "",
          chatAgentProvider: "local",
        });
      `,
      "/stores/aiProvider": `
        export const useAiProvider = () => ({
          kind: "local",
          model: "qwen3:8b",
          cloudProvider: "openrouter",
          cloudBaseUrl: "",
          serverUrl: "",
        });
        export const resolveCommandParsing = () => ({ parser: "local", model: "qwen3:8b" });
      `,
      "/stores/connectorApprovalStore": `
        export const approvalKey = (m, t) => m + ":" + t;
        export const useConnectorApprovalStore = (selector) => selector({ entries: {} });
      `,
      "/commandMode/typedClause": `
        export const commandReferencesSelection = () => false;
      `,
      "/overlay/assistantChatContinuity": `
        export const touchAssistantChatActivity = () => {};
      `,
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/useVoiceDraft": `export const useVoiceDraft = () => ({ status: "idle", streamingOnlyProvider: false });`,
      "/stores/meetingRecordingStore": `
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = { getState: () => ({ currentMicLevel: 0 }) };
      `,
    },
  });

  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const { AssistantPanel } = await vite.ssrLoadModule("/components/dictation/AssistantPanel.tsx");
  root = createRoot(container);

  await React.act(async () => {
    root.render(
      React.createElement(AssistantPanel, {
        pendingCommand,
        onCommandConsumed: () => {},
        onCommandDiscarded: () => {},
        onCommandSettled: () => {},
        initialConversationId: null,
        onConversationIdChange: () => {},
        voiceState: "idle",
        thinking: false,
        open,
        footerPhase: "pill",
        horizontalDirection: "right",
        onClose: () => closeCalls.push(true),
        onBusyChange: () => {},
        onResponseReadyChange: () => {},
        onResponseContent: () => {},
        onConversationReset: () => {},
        onSelectionContextChange: () => {},
      })
    );
  });

  const dispatchEscape = () =>
    React.act(async () => {
      for (const listener of docListeners.get("keydown") ?? []) {
        listener({ key: "Escape", preventDefault() {}, target: container });
      }
    });

  return {
    container,
    cancelledCalls,
    closeCalls,
    emitProgress: (payload) => React.act(async () => progressCb?.(payload)),
    dispatchEscape,
  };
}

test("Escape cancels an in-flight Command Mode request via overlayCommandCancel", async (t) => {
  const inflight = createDeferred();
  const { container, cancelledCalls, closeCalls, dispatchEscape } = await mountAssistantPanel(t, {
    open: true,
    pendingCommand: {
      id: 1,
      text: "open notepad",
      attachment: null,
      selectedContext: null,
      delivery: null,
    },
    orchestrate: () => inflight.promise,
  });

  // In-flight Command Mode surfaces a working status pill and enables the composer cancel button.
  const statusPill = findElement(
    container,
    (el) => el.getAttribute?.("data-command-progress-phase") !== null
  );
  assert.ok(statusPill);
  assert.match(statusPill.textContent, /Working/);

  const composerCancel = findElement(
    container,
    (el) => el.tagName === "BUTTON" && el.getAttribute?.("aria-label") === "Cancel"
  );
  assert.ok(composerCancel, "ChatInput exposes cancel button while Command Mode is in flight");

  await dispatchEscape();
  assert.equal(cancelledCalls.length, 1, "Escape triggers overlayCommandCancel");
  assert.equal(closeCalls.length, 0, "open panel stays open when cancelling in-flight command");

  await React.act(async () => {
    inflight.resolve({ handled: true, success: false, message: "Cancelled" });
    await inflight.promise;
  });
});

test("onOverlayCommandProgress surfaces live step and writing phases and clears on done", async (t) => {
  const inflight = createDeferred();
  const { container, emitProgress } = await mountAssistantPanel(t, {
    open: true,
    pendingCommand: {
      id: 2,
      text: "write a haiku",
      attachment: null,
      selectedContext: null,
      delivery: null,
    },
    orchestrate: () => inflight.promise,
  });

  await emitProgress({ phase: "step", current: 1, total: 3, text: "Working... step 1/3" });
  let statusPill = findElement(
    container,
    (el) => el.getAttribute?.("data-command-progress-phase") === "step"
  );
  assert.ok(statusPill);
  assert.match(statusPill.textContent, /Working\.\.\. step 1\/3/);

  await emitProgress({ phase: "writing" });
  statusPill = findElement(
    container,
    (el) => el.getAttribute?.("data-command-progress-phase") === "writing"
  );
  assert.ok(statusPill);
  assert.match(statusPill.textContent, /Writing/);

  await emitProgress({ phase: "done", code: "OK" });
  // While orchestrator promise is still unwinding, phase reverts to working until settled,
  // and once resolved, the progress pill disappears.
  await React.act(async () => {
    inflight.resolve({ handled: true, success: true, message: "Done" });
    await inflight.promise;
  });

  statusPill = findElement(
    container,
    (el) => el.getAttribute?.("data-command-progress-phase") !== null
  );
  assert.equal(statusPill, null);
});

test("Escape on hidden panel cancels Command Mode and dismisses compact shell", async (t) => {
  const inflight = createDeferred();
  const { cancelledCalls, closeCalls, dispatchEscape } = await mountAssistantPanel(t, {
    open: false,
    pendingCommand: {
      id: 3,
      text: "open calculator",
      attachment: null,
      selectedContext: null,
      delivery: null,
    },
    orchestrate: () => inflight.promise,
  });

  await dispatchEscape();
  assert.equal(cancelledCalls.length, 1);
  assert.equal(closeCalls.length, 1);

  await React.act(async () => {
    inflight.resolve({ handled: true, success: false, message: "Cancelled" });
    await inflight.promise;
  });
});

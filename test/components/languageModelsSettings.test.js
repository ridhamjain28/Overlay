const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function findAllElements(root, predicate, out = []) {
  if (root.nodeType === 1 && predicate(root)) out.push(root);
  for (const child of root.childNodes) {
    findAllElements(child, predicate, out);
  }
  return out;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mountLanguageModelsSettings(t, { overlayOllamaModels }) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__aiProviderTestState;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        overlayOllamaModels,
        overlayRecommendModel: async () => ({ model: "qwen3:8b" }),
      },
    },
  });
  const container = installInteractiveDom(t);
  const origCreateElement = globalThis.document.createElement;
  globalThis.document.createElement = (tagName) => {
    const el = origCreateElement(tagName);
    if (String(tagName).toLowerCase() === "select") {
      Object.defineProperty(el, "options", {
        get() {
          return this.childNodes.filter((c) => c.tagName === "OPTION");
        },
        configurable: true,
      });
    }
    return el;
  };

  globalThis.__aiProviderTestState = {
    kind: "local",
    model: "qwen3:8b",
    cloudProvider: "openrouter",
    cloudBaseUrl: "",
    serverUrl: "",
    apiKey: "",
    autoSelect: false,
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-language-models-settings-test-",
    mockModules: {
      "/stores/aiProvider": `
        import { useState } from "react";
        export const useAiProvider = (selector) => {
          const [, setTick] = useState(0);
          const state = {
            ...globalThis.__aiProviderTestState,
            update: (patch) => {
              Object.assign(globalThis.__aiProviderTestState, patch);
              setTick((n) => n + 1);
            },
            selectKind: (kind) => {
              globalThis.__aiProviderTestState.kind = kind;
              globalThis.__aiProviderTestState.onChange?.();
              setTick((n) => n + 1);
            },
            setApiKey: (apiKey) => {
              globalThis.__aiProviderTestState.apiKey = apiKey;
              setTick((n) => n + 1);
            },
          };
          return selector(state);
        };
      `,
      "/stores/settingsStore": `
        import { useState } from "react";
        export const useSettingsStore = (selector) => {
          const [, setTick] = useState(0);
          return selector({
            overlayModelAutoSelect: globalThis.__aiProviderTestState.autoSelect,
            setOverlayModelAutoSelect: (v) => {
              globalThis.__aiProviderTestState.autoSelect = v;
              setTick((n) => n + 1);
            },
          });
        };
      `,
      "/ReasoningModelSelector": `
        import { createElement } from "react";
        export default function ReasoningModelSelector() {
          return createElement("div", { "data-testid": "cloud-selector" });
        }
      `,
    },
  });
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const { default: LanguageModelsSettings } = await vite.ssrLoadModule(
    "/components/settings/LanguageModelsSettings.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(LanguageModelsSettings)));
  return { root, container, LanguageModelsSettings };
}

test("LocalModelPicker shows loading state, allows manual refresh, and updates model options", async (t) => {
  const firstFetch = createDeferred();
  let calls = 0;
  const { container } = await mountLanguageModelsSettings(t, {
    overlayOllamaModels: () => {
      calls += 1;
      if (calls === 1) return firstFetch.promise;
      return Promise.resolve(["qwen3:8b", "llama3.2:3b"]);
    },
  });

  const refreshBtn = () =>
    findElement(
      container,
      (el) => el.getAttribute?.("data-testid") === "ai-local-models-refresh"
    );

  assert.ok(refreshBtn());
  assert.equal(refreshBtn().getAttribute("aria-busy"), "true");
  assert.match(container.textContent, /Loading/);

  await React.act(async () => {
    firstFetch.resolve(["qwen3:8b"]);
    await firstFetch.promise;
  });

  assert.equal(refreshBtn().getAttribute("aria-busy"), "false");
  assert.equal(calls, 1);

  await React.act(async () => {
    refreshBtn().dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} });
  });

  assert.equal(calls, 2);
  const select = findElement(
    container,
    (el) => el.getAttribute?.("data-testid") === "ai-local-model"
  );
  const optionValues = findAllElements(select, (el) => el.tagName === "OPTION").map(
    (el) => el.textContent
  );
  assert.deepEqual(optionValues, ["qwen3:8b", "llama3.2:3b"]);
});

test("LocalModelPicker surfaces distinct feedback when Ollama is unreachable vs empty", async (t) => {
  let result = null;
  const { container } = await mountLanguageModelsSettings(t, {
    overlayOllamaModels: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });

  assert.match(container.textContent, /Couldn't reach Ollama/);

  result = [];
  const refreshBtn = findElement(
    container,
    (el) => el.getAttribute?.("data-testid") === "ai-local-models-refresh"
  );
  await React.act(async () => {
    refreshBtn.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} });
  });
  assert.match(container.textContent, /No models found/);

  result = new Error("connection refused");
  await React.act(async () => {
    refreshBtn.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} });
  });
  assert.match(container.textContent, /Couldn't reach Ollama/);
});

test("provider kind radiogroup supports arrow-key navigation", async (t) => {
  const { root, container, LanguageModelsSettings } = await mountLanguageModelsSettings(t, {
    overlayOllamaModels: async () => ["qwen3:8b"],
  });
  globalThis.__aiProviderTestState.onChange = () => {
    root.render(React.createElement(LanguageModelsSettings));
  };

  const localRadio = findElement(
    container,
    (el) => el.getAttribute?.("data-testid") === "ai-kind-local"
  );
  localRadio.focus();

  await React.act(async () => {
    localRadio.dispatchEvent({
      type: "keydown",
      key: "ArrowDown",
      bubbles: true,
      preventDefault() {
        this.defaultPrevented = true;
      },
    });
  });

  assert.equal(globalThis.__aiProviderTestState.kind, "own-server");
  assert.equal(
    container.ownerDocument.activeElement?.getAttribute?.("data-testid"),
    "ai-kind-own-server"
  );
});

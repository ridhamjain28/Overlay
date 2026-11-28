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

async function mountConnectorsSettings(t, apiOverrides = {}) {
  let root;
  const windowListeners = new Map();
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const api = {
    list: async () => [
      {
        name: "github",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        status: "disconnected",
        toolsCount: 0,
      },
    ],
    configGet: async () => ({ text: "{\n  \"mcpServers\": {}\n}", path: "", servers: {}, errors: [] }),
    configSave: async () => ({ ok: true, errors: [] }),
    permissionsList: async () => [
      { key: "github:create_issue", type: "mcp", server: "github", tool: "create_issue", allowedAt: 1700000000000 },
    ],
    permissionsRevoke: async () => ({ ok: true }),
    connect: async () => ({ ok: true }),
    disconnect: async () => ({ ok: true }),
    auth: async () => ({ ok: true }),
    test: async () => ({ ok: true, tools: [] }),
    add: async () => ({ ok: true, errors: [] }),
    remove: async () => ({ ok: true, errors: [] }),
    tools: async () => [],
    setToolEnabled: async () => ({ ok: true }),
    gallery: async () => [
      {
        id: "filesystem",
        name: "Filesystem",
        description: "Local files",
        type: "stdio",
        config: { command: "npx", args: ["-y", "server-fs"] },
        needsAuth: false,
      },
    ],
    importDiscover: async () => [],
    importServers: async () => ({ ok: true, imported: 0, errors: [] }),
    onStatus: () => () => {},
    ...apiOverrides,
  };

  installBrowserGlobals(t, {
    window: {
      addEventListener: (event, cb) => windowListeners.set(event, cb),
      removeEventListener: (event) => windowListeners.delete(event),
      electronAPI: {
        overlayMcp: api,
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

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connectors-settings-test-",
  });
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const { default: ConnectorsSettings } = await vite.ssrLoadModule(
    "/components/settings/ConnectorsSettings.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(ConnectorsSettings)));
  return { root, container, windowListeners };
}

test("ConnectorsSettings renders Saved Permissions once and sets accessible labels", async (t) => {
  const { container } = await mountConnectorsSettings(t);

  const permissionHeaders = findAllElements(
    container,
    (el) => el.tagName === "H3" && el.textContent === "Saved Permissions"
  );
  assert.equal(permissionHeaders.length, 1, "duplicate Saved Permissions panel is removed");

  const toggleToolsBtn = findElement(
    container,
    (el) => el.tagName === "BUTTON" && el.getAttribute?.("aria-expanded") !== null
  );
  assert.ok(toggleToolsBtn);
  assert.equal(toggleToolsBtn.getAttribute("aria-label"), "Show tools for github");

  const removeBtn = findElement(
    container,
    (el) => el.tagName === "BUTTON" && el.getAttribute?.("aria-label") === "Remove github"
  );
  assert.ok(removeBtn, "icon-only remove button has an accessible label");

  const serverNameInput = findElement(
    container,
    (el) => el.tagName === "INPUT" && el.getAttribute?.("id") === "mcp-server-name"
  );
  const serverNameLabel = findElement(
    container,
    (el) => el.tagName === "LABEL" && el.getAttribute?.("for") === "mcp-server-name"
  );
  assert.ok(serverNameInput && serverNameLabel, "form label is associated with its input");
});

test("ConnectorsSettings surfaces errors when connect returns ok:false or list fails", async (t) => {
  let shouldFailList = true;
  const { container } = await mountConnectorsSettings(t, {
    list: async () => {
      if (shouldFailList) throw new Error("IPC list unavailable");
      return [
        {
          name: "github",
          type: "stdio",
          command: "npx",
          status: "disconnected",
          toolsCount: 0,
        },
      ];
    },
    connect: async () => ({ ok: false, error: "Spawn ENOENT" }),
  });

  const alert = findElement(container, (el) => el.getAttribute?.("role") === "alert");
  assert.ok(alert);
  assert.match(alert.textContent, /IPC list unavailable/);

  shouldFailList = false;
  const retryBtn = findElement(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.includes("Retry")
  );
  assert.ok(retryBtn);
  await React.act(async () => {
    retryBtn.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} });
  });

  const connectBtn = findElement(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.includes("Connect")
  );
  await React.act(async () => {
    connectBtn.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} });
  });

  const connectAlert = findElement(container, (el) => el.getAttribute?.("role") === "alert");
  assert.ok(connectAlert);
  assert.match(connectAlert.textContent, /Spawn ENOENT/);
});

test("Gallery modal supports Escape close and restores focus to the trigger button", async (t) => {
  const { container, windowListeners } = await mountConnectorsSettings(t);

  const galleryBtn = findElement(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.includes("Browse Gallery")
  );
  assert.ok(galleryBtn);
  galleryBtn.focus();

  await React.act(async () => {
    galleryBtn.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} });
  });

  const dialog = findElement(container, (el) => el.getAttribute?.("role") === "dialog");
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(
    container.ownerDocument.activeElement?.getAttribute?.("aria-label"),
    "Close",
    "focus moves into the opened modal"
  );

  await React.act(async () => {
    windowListeners.get("keydown")?.({
      key: "Escape",
      preventDefault() {},
    });
  });

  assert.equal(
    findElement(container, (el) => el.getAttribute?.("role") === "dialog"),
    null,
    "Escape closes the dialog"
  );
  assert.equal(
    container.ownerDocument.activeElement,
    galleryBtn,
    "closing the dialog restores focus to the trigger button"
  );
});

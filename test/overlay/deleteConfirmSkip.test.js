const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const ROOT = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function collect(node, result = []) {
  if (!node || typeof node !== "object") return result;
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, result));
    return result;
  }
  if (node.props) {
    result.push(node);
    collect(node.props.children, result);
  }
  return result;
}

async function loadPrefs() {
  return import("../../src/utils/confirmPreferences.ts");
}

test("skipped delete confirmations persist per kind and can be turned back on", async () => {
  const prefs = await loadPrefs();
  const storage = memoryStorage();
  assert.equal(prefs.isConfirmSkipped("historyItem", storage), false);
  prefs.setConfirmSkipped("historyItem", true, storage);
  prefs.setConfirmSkipped("historyItem", true, storage);
  assert.equal(prefs.isConfirmSkipped("historyItem", storage), true);
  assert.equal(prefs.isConfirmSkipped("chatConversation", storage), false);
  assert.deepEqual(JSON.parse(storage.getItem(prefs.CONFIRM_SKIPS_STORAGE_KEY)), ["historyItem"]);

  prefs.setConfirmSkipped("historyItem", false, storage);
  assert.equal(prefs.isConfirmSkipped("historyItem", storage), false);

  prefs.skipAllConfirmations(storage);
  assert.deepEqual(prefs.getSkippedConfirmations(storage), [...prefs.CONFIRM_SKIP_KINDS]);
  prefs.resetConfirmSkips(storage);
  assert.deepEqual(prefs.getSkippedConfirmations(storage), []);
  assert.equal(storage.getItem(prefs.CONFIRM_SKIPS_STORAGE_KEY), null);
});

test("corrupt or unknown stored values never skip a confirmation", async () => {
  const prefs = await loadPrefs();
  const bad = memoryStorage({ [prefs.CONFIRM_SKIPS_STORAGE_KEY]: "{not json" });
  assert.deepEqual(prefs.getSkippedConfirmations(bad), []);
  const unknown = memoryStorage({
    [prefs.CONFIRM_SKIPS_STORAGE_KEY]: JSON.stringify(["deleteAccount", "clearAll", 3]),
  });
  assert.deepEqual(prefs.getSkippedConfirmations(unknown), []);
  assert.equal(prefs.isConfirmSkipped(undefined, unknown), false);
  assert.equal(prefs.isConfirmSkipped("historyItem", null), false);
  // Only the listed single-item kinds can ever be skipped.
  assert.deepEqual([...prefs.CONFIRM_SKIP_KINDS].sort(), [
    "chatConversation",
    "emptyFolder",
    "historyItem",
    "localModel",
  ]);
});

async function renderer(t, initialStorage) {
  installBrowserGlobals(t, { initialStorage });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "overlay-delete-confirm-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
    },
  });
  return { container, vite };
}

test("useDialogs runs a skipped kind at once and still asks for everything else", async (t) => {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  const { container, vite } = await renderer(t, {
    skippedDeleteConfirmations: JSON.stringify(["historyItem"]),
  });
  const { useDialogs } = await vite.ssrLoadModule("/hooks/useDialogs.ts");
  let hook;
  function Harness() {
    hook = useDialogs();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  const ran = [];
  await React.act(async () => {
    hook.showConfirmDialog({
      title: "Delete?",
      onConfirm: () => ran.push("history"),
      variant: "destructive",
      dontAskAgainKey: "historyItem",
    });
  });
  assert.deepEqual(ran, ["history"]);
  assert.equal(hook.confirmDialog.open, false);

  await React.act(async () => {
    hook.showConfirmDialog({
      title: "Delete chat?",
      onConfirm: () => ran.push("chat"),
      dontAskAgainKey: "chatConversation",
    });
  });
  assert.deepEqual(ran, ["history"]);
  assert.equal(hook.confirmDialog.open, true);
  assert.equal(hook.confirmDialog.dontAskAgainKey, "chatConversation");

  await React.act(async () => hook.hideConfirmDialog());
  await React.act(async () => {
    hook.showConfirmDialog({ title: "Clear all?", onConfirm: () => ran.push("clear") });
  });
  assert.equal(hook.confirmDialog.open, true, "dialogs without a key always ask");
});

test("ConfirmDialog shows Don't ask me again only when given a key and saves it on confirm", async (t) => {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  const { container, vite } = await renderer(t, {});
  const { ConfirmDialog } = await vite.ssrLoadModule("/components/ui/dialog.tsx");
  let tree;
  let props;
  function Harness() {
    tree = ConfirmDialog(props);
    return null;
  }
  root = createRoot(container);
  const confirmed = [];
  const base = {
    open: true,
    onOpenChange() {},
    title: "Delete?",
    onConfirm: () => confirmed.push(1),
    variant: "destructive",
    confirmText: "Delete",
  };

  props = base;
  await React.act(async () => root.render(React.createElement(Harness)));
  const plain = collect(tree);
  assert.equal(
    plain.some((n) => n.props["data-testid"] === "confirm-dont-ask-again"),
    false
  );

  props = { ...base, dontAskAgainKey: "chatConversation" };
  await React.act(async () => root.render(React.createElement(Harness)));
  let nodes = collect(tree);
  const box = nodes.find((n) => n.props["data-testid"] === "confirm-dont-ask-again");
  assert.ok(box, "checkbox rendered");
  assert.equal(box.props.checked, false);
  assert.ok(
    nodes.some(
      (n) =>
        n.props.children === "common.dontAskAgain" ||
        (Array.isArray(n.props.children) && n.props.children.includes("common.dontAskAgain"))
    )
  );

  const confirmButton = () =>
    collect(tree).find(
      (n) => n.props.children === "Delete" && typeof n.props.onClick === "function"
    );

  // Confirming without ticking the box keeps asking next time.
  await React.act(async () => confirmButton().props.onClick());
  assert.equal(globalThis.localStorage.getItem("skippedDeleteConfirmations"), null);

  await React.act(async () => box.props.onChange({ target: { checked: true } }));
  nodes = collect(tree);
  assert.equal(
    nodes.find((n) => n.props["data-testid"] === "confirm-dont-ask-again").props.checked,
    true
  );
  await React.act(async () => confirmButton().props.onClick());
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem("skippedDeleteConfirmations")), [
    "chatConversation",
  ]);
  assert.equal(confirmed.length, 2);
});

test("single-item deletes offer Don't ask me again; bulk and account actions do not", () => {
  const expectations = [
    ["src/components/ControlPanel.tsx", 'dontAskAgainKey: "historyItem"', 1],
    ["src/components/chat/ChatView.tsx", 'dontAskAgainKey: "chatConversation"', 1],
    ["src/components/notes/SpacesTree.tsx", '"emptyFolder"', 1],
    ["src/components/LocalModelPicker.tsx", 'dontAskAgainKey: "localModel"', 1],
    ["src/components/LocalWhisperPicker.tsx", 'dontAskAgainKey: "localModel"', 1],
    ["src/components/TranscriptionModelPicker.tsx", 'dontAskAgainKey: "localModel"', 2],
  ];
  for (const [file, needle, count] of expectations) {
    const source = read(file);
    assert.equal(source.split(needle).length - 1, count, `${file} ${needle}`);
    assert.match(source, /dontAskAgainKey=\{confirmDialog\.dontAskAgainKey\}/, file);
  }
  // A folder that still holds notes always asks.
  assert.match(
    read("src/components/notes/SpacesTree.tsx"),
    /count > 0 \? undefined : "emptyFolder"/
  );
  // Clear-all history, reset app data and account deletion stay unconditional.
  const control = read("src/components/ControlPanel.tsx");
  const clearAll = control.slice(control.indexOf("const clearAllTranscriptions"));
  assert.doesNotMatch(clearAll.slice(0, clearAll.indexOf("}, [")), /dontAskAgainKey/);
  const settings = read("src/components/SettingsPage.tsx");
  assert.doesNotMatch(settings, /dontAskAgainKey/);
});

test("Settings offers Ask before deleting, and every locale has the new strings", () => {
  const settings = read("src/components/SettingsPage.tsx");
  assert.match(settings, /settingsPage\.general\.confirmations\.askBeforeDeleting"/);
  assert.match(
    settings,
    /<Toggle checked=\{askBeforeDeleting\} onChange=\{setAskBeforeDeleting\} \/>/
  );
  assert.match(settings, /if \(enabled\) resetConfirmSkips\(\);/);
  const localesDir = path.join(ROOT, "src/locales");
  for (const locale of fs.readdirSync(localesDir)) {
    const file = path.join(localesDir, locale, "translation.json");
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(data.common.dontAskAgain, `${locale} common.dontAskAgain`);
    const c = data.settingsPage.general.confirmations;
    for (const key of [
      "title",
      "description",
      "askBeforeDeleting",
      "askBeforeDeletingDescription",
    ]) {
      assert.ok(c?.[key], `${locale} confirmations.${key}`);
    }
  }
});

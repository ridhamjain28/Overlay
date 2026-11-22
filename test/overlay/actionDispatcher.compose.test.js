const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCommandDispatcher,
  validateCommandRequest,
  PLAN_STEP_DELAY_MS,
} = require("../../src/helpers/overlay/commandMode/actionDispatcher");

const LETTER = "Dear Mother,\n\nPlease let me come home for a holiday.\n\nLove";
const PROMPT = "a letter to my mother asking for a holiday to come home";

function make(over = {}) {
  const calls = [];
  const dispatcher = createCommandDispatcher({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\test", ProgramData: "", APPDATA: "" },
    execFile: async (file, args, options) => {
      calls.push({ kind: "open", file, args, options });
      return { stdout: "ok\n", stderr: "" };
    },
    openPath: async (p) => {
      calls.push({ kind: "openPath", path: p });
      return "";
    },
    openExternal: async (u) => {
      calls.push({ kind: "openExternal", url: u });
    },
    confirm: async (message) => {
      calls.push({ kind: "confirm", message });
      return over.confirmValue ?? false;
    },
    pasteText: async (text, options) => {
      calls.push({ kind: "paste", text, options });
    },
    composeText: async (prompt, extra = {}) => {
      calls.push({ kind: "compose", prompt, extra });
      if (typeof over.composeText === "function") return over.composeText(prompt, extra);
      return LETTER;
    },
    focusApp: async (name) => {
      calls.push({ kind: "focus", name });
    },
    onProgress: (phase) => {
      calls.push({ kind: "progress", phase });
    },
    fsImpl: { readdirSync: () => [], existsSync: () => false },
    getAutoRunTrusted: () => over.autoRunTrusted === true,
    isEnabled: () => over.enabled !== false,
    wait: over.wait || (async (ms) => {
      calls.push({ kind: "wait", ms });
    }),
    ...over,
  });
  return { dispatcher, calls };
}

const plan = {
  action: "plan",
  steps: [
    { action: "open_app", args: { app: "notepad" } },
    { action: "compose_text", args: { prompt: PROMPT } },
  ],
};

test("validateCommandRequest accepts compose_text with a prompt", () => {
  const r = validateCommandRequest({ action: "compose_text", args: { prompt: PROMPT } });
  assert.equal(r.ok, true);
  assert.equal(r.action, "compose_text");
  assert.equal(r.args.prompt, PROMPT);
});

test("a compose plan opens the app before the writer is called, then focuses and pastes", async () => {
  const { dispatcher, calls } = make({ autoRunTrusted: true });
  const r = await dispatcher.perform(plan);
  assert.equal(r.success, true);
  const kinds = calls.map((c) => c.kind);
  assert.ok(kinds.indexOf("open") >= 0, "app should open");
  assert.ok(kinds.indexOf("compose") > kinds.indexOf("open"), "writer starts after open");
  assert.ok(kinds.indexOf("focus") > kinds.indexOf("compose"), "focus after writing");
  assert.ok(kinds.indexOf("paste") > kinds.indexOf("focus"), "paste after focus");
  assert.equal(calls.find((c) => c.kind === "open").file, "notepad.exe");
  assert.equal(calls.find((c) => c.kind === "compose").prompt, PROMPT);
  assert.equal(calls.find((c) => c.kind === "focus").name, "Notepad");
  const paste = calls.find((c) => c.kind === "paste");
  assert.equal(paste.text, LETTER);
  assert.equal(paste.options.restoreClipboard, true);
  const progress = calls.filter((c) => c.kind === "progress").map((c) => c.phase);
  assert.deepEqual(progress, ["writing", "pasting"]);
});

test("compose generation starts immediately and does not wait on the focus delay", async () => {
  const order = [];
  const { dispatcher } = make({
    autoRunTrusted: true,
    execFile: async (file) => {
      order.push("open:" + file);
      return { stdout: "", stderr: "" };
    },
    composeText: async () => {
      order.push("compose");
      return LETTER;
    },
    wait: () =>
      new Promise((resolve) => {
        order.push("wait-start");
        setTimeout(() => {
          order.push("wait-end");
          resolve();
        }, 40);
      }),
    focusApp: async (name) => {
      order.push("focus:" + name);
    },
    pasteText: async () => {
      order.push("paste");
    },
  });
  const r = await dispatcher.perform(plan);
  assert.equal(r.success, true);
  assert.deepEqual(order.slice(0, 3), ["open:notepad.exe", "wait-start", "compose"]);
  assert.ok(order.indexOf("compose") < order.indexOf("wait-end"));
  assert.ok(order.indexOf("focus:Notepad") > order.indexOf("wait-end"));
  assert.equal(order.at(-1), "paste");
});

test("a compose plan asks for one confirmation that lists both steps", async () => {
  const { dispatcher, calls } = make({ confirmValue: true });
  const r = await dispatcher.perform(plan);
  assert.equal(r.success, true);
  const confirms = calls.filter((c) => c.kind === "confirm");
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /Open app: notepad/i);
  assert.match(confirms[0].message, /Write: a letter to my mother/i);
});

test("compose failure types nothing", async () => {
  const { dispatcher, calls } = make({
    autoRunTrusted: true,
    composeText: async () => {
      throw new Error("writer failed");
    },
  });
  const r = await dispatcher.perform(plan);
  assert.equal(r.success, false);
  assert.equal(r.code, "COMPOSE_FAILED");
  assert.match(r.error, /nothing was typed/i);
  assert.ok(!calls.some((c) => c.kind === "paste"));
});

test("compose timeout types nothing", async () => {
  const { dispatcher, calls } = make({
    autoRunTrusted: true,
    composeText: async () => {
      const err = new Error("Writing timed out");
      err.code = "TIMEOUT";
      err.name = "AbortError";
      throw err;
    },
  });
  const r = await dispatcher.perform(plan);
  assert.equal(r.success, false);
  assert.equal(r.code, "TIMEOUT");
  assert.match(r.error, /nothing was typed/i);
  assert.ok(!calls.some((c) => c.kind === "paste"));
});

test("cancelling compose types nothing", async () => {
  const { dispatcher, calls } = make({
    autoRunTrusted: true,
    composeText: async (_prompt, { signal }) => {
      const err = new Error("aborted");
      err.name = "AbortError";
      signal.aborted = true;
      throw err;
    },
  });
  const ac = { signal: { aborted: false } };
  const r = await dispatcher.perform(plan, { signal: ac.signal });
  assert.equal(r.success, false);
  assert.equal(r.code, "CANCELLED");
  assert.ok(!calls.some((c) => c.kind === "paste"));
});

test("empty compose output types nothing", async () => {
  const { dispatcher, calls } = make({
    autoRunTrusted: true,
    composeText: async () => "   ",
  });
  const r = await dispatcher.perform(plan);
  assert.equal(r.success, false);
  assert.equal(r.code, "COMPOSE_FAILED");
  assert.ok(!calls.some((c) => c.kind === "paste"));
});

test("open_app does not wait for the launched app to exit and sets no kill timeout", async () => {
  const seen = [];
  const { dispatcher, calls } = make({
    autoRunTrusted: true,
    execFile: (file, args, options) => {
      seen.push(options);
      return new Promise(() => {}); // the app keeps running; never settles
    },
  });
  const started = Date.now();
  const r = await dispatcher.perform(plan);
  assert.equal(r.success, true);
  assert.ok(Date.now() - started < 3000);
  assert.equal(seen[0].timeout, undefined);
  assert.ok(calls.some((c) => c.kind === "paste"));
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCommandDispatcher,
  validateCommandRequest,
  PLAN_STEP_DELAY_MS,
} = require("../../src/helpers/overlay/commandMode/actionDispatcher");

function make(over = {}) {
  const calls = [];
  const waits = [];
  const dispatcher = createCommandDispatcher({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\test", ProgramData: "", APPDATA: "" },
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "ok\n", stderr: "" };
    },
    openPath: async (p) => {
      calls.push({ openPath: p });
      return "";
    },
    openExternal: async (u) => {
      calls.push({ open: u });
    },
    confirm: async (message) => {
      calls.push({ confirm: message });
      return over.confirmValue ?? false;
    },
    pasteText: async (text, options) => {
      calls.push({ paste: text, options });
    },
    fsImpl: { readdirSync: () => [], existsSync: () => false },
    getAutoRunTrusted: () => over.autoRunTrusted === true,
    isEnabled: () => over.enabled !== false,
    wait: async (ms) => {
      waits.push(ms);
    },
    ...over,
  });
  return { dispatcher, calls, waits };
}

test("validateCommandRequest rejects open_app names that contain a connector", () => {
  const r = validateCommandRequest({
    action: "open_app",
    args: { app: "notepad and in it type hello" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_ALLOWED");
});

test("a plan asks for one confirmation listing both steps, then waits before typing", async () => {
  const { dispatcher, calls, waits } = make({ confirmValue: true });
  const r = await dispatcher.perform({
    action: "plan",
    steps: [
      { action: "open_app", args: { app: "notepad" } },
      { action: "type_text", args: { text: "hello" } },
    ],
  });
  assert.equal(r.success, true);
  const confirms = calls.filter((c) => c.confirm);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].confirm, /Open app: notepad/i);
  assert.match(confirms[0].confirm, /Type text: hello/i);
  assert.ok(calls.some((c) => c.file === "notepad.exe"));
  assert.ok(calls.some((c) => c.paste === "hello"));
  assert.deepEqual(waits, [PLAN_STEP_DELAY_MS]);
  assert.equal(PLAN_STEP_DELAY_MS, 1500);
});

test("autoRunTrusted plans skip confirmation but still wait between steps", async () => {
  const { dispatcher, calls, waits } = make({ autoRunTrusted: true, confirmValue: false });
  const r = await dispatcher.perform(
    {
      action: "plan",
      steps: [
        { action: "open_app", args: { app: "notepad" } },
        { action: "type_text", args: { text: "hello" } },
      ],
    },
    { autoRunTrusted: true }
  );
  assert.equal(r.success, true);
  assert.equal(calls.some((c) => c.confirm), false);
  assert.deepEqual(waits, [1500]);
});

test("run_command still always confirms, including when it is a plan step", async () => {
  const { dispatcher, calls } = make({ autoRunTrusted: true, confirmValue: false });
  const r = await dispatcher.perform(
    {
      action: "plan",
      steps: [{ action: "run_command", args: { command: "echo hi" } }],
    },
    { autoRunTrusted: true }
  );
  assert.equal(r.code, "CANCELLED");
  assert.equal(calls.filter((c) => c.confirm).length, 1);
  assert.equal(calls.some((c) => c.file === "cmd.exe"), false);
});
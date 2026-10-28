const test = require("node:test");
const assert = require("node:assert/strict");
const sa = require("../../src/helpers/overlay/systemActions.js");

const make = (over = {}) => {
  const calls = [];
  const actions = sa.createSystemActions({
    platform: "win32",
    env: {},
    execFile: async (file, args) => calls.push({ file, args }),
    openPath: async () => "",
    openExternal: async (u) => calls.push({ open: u }),
    confirm: async () => false,
    picturesDir: "/tmp",
    fsImpl: { mkdirSync() {}, readdirSync: () => [], existsSync: () => false },
    ...over,
  });
  return { actions, calls };
};

test("unknown and dangerous actions are rejected", async () => {
  const { actions, calls } = make();
  for (const action of ["shutdown", "restart", "delete_file", "run_command", "", undefined]) {
    const r = await actions.perform({ action });
    assert.equal(r.success, false, String(action));
    assert.equal(r.code, "NOT_ALLOWED");
  }
  assert.equal(calls.length, 0);
});

test("shells and system tools cannot be opened as apps", async () => {
  const { actions, calls } = make();
  for (const app of ["powershell", "cmd", "Windows Terminal", "regedit", "wsl"]) {
    const r = await actions.perform({ action: "open_app", app });
    assert.equal(r.success, false, app);
  }
  assert.equal(calls.length, 0);
});

test("only http(s) URLs open", async () => {
  const { actions } = make();
  assert.equal(
    (await actions.perform({ action: "open_url", url: "file:///C:/Windows" })).success,
    false
  );
  assert.equal(
    (await actions.perform({ action: "open_url", url: "javascript:alert(1)" })).success,
    false
  );
  assert.equal(
    (await actions.perform({ action: "open_url", url: "https://example.com" })).success,
    true
  );
});

test("levels are clamped to 0-100", () => {
  assert.equal(sa.validateRequest({ action: "volume_set", level: 140 }).params.level, 100);
  assert.equal(sa.validateRequest({ action: "brightness_set", level: -5 }).params.level, 0);
});

test("risky actions need confirmation; cancel means nothing runs", async () => {
  const { actions, calls } = make({ confirm: async () => false });
  for (const action of ["lock_screen", "screenshot"]) {
    const r = await actions.perform({ action });
    assert.equal(r.code, "CANCELLED");
  }
  assert.equal((await actions.perform({ action: "brightness_set", level: 50 })).code, "CANCELLED");
  assert.equal(calls.length, 0);
});

test("allowed lock runs only the fixed command after confirmation", async () => {
  const { actions, calls } = make({ confirm: async () => true });
  const r = await actions.perform({ action: "lock_screen" });
  assert.equal(r.success, true);
  assert.deepEqual(calls[0], { file: "rundll32.exe", args: ["user32.dll,LockWorkStation"] });
});

test("volume uses a hidden PowerShell with a fixed key script", async () => {
  const { actions, calls } = make();
  await actions.perform({ action: "volume_down" });
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(calls[0].args.includes("Hidden"));
});

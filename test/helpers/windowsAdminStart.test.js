const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BASE_TASK_NAME,
  HIDDEN_LAUNCH_FLAG,
  taskNameForChannel,
  allManagedTaskNames,
  shouldUseLogonTask,
  buildTaskCommand,
  getPackagedLaunchSpec,
  buildCreateArgs,
  buildDeleteArgs,
  parseQueryResult,
  buildRelaunchPowerShell,
} = require("../../src/helpers/windowsAdminStart.js");

test("the logon task is used only on Windows when admin start and auto-start are both on", () => {
  assert.equal(
    shouldUseLogonTask({ platform: "win32", runAsAdmin: true, autoStartEnabled: true }),
    true
  );
  assert.equal(
    shouldUseLogonTask({ platform: "win32", runAsAdmin: true, autoStartEnabled: false }),
    false
  );
  assert.equal(
    shouldUseLogonTask({ platform: "win32", runAsAdmin: false, autoStartEnabled: true }),
    false
  );
  assert.equal(
    shouldUseLogonTask({ platform: "darwin", runAsAdmin: true, autoStartEnabled: true }),
    false
  );
  assert.equal(
    shouldUseLogonTask({ platform: "linux", runAsAdmin: true, autoStartEnabled: true }),
    false
  );
});

test("task names stay in lockstep with the app id and release channel", () => {
  assert.equal(taskNameForChannel("production"), BASE_TASK_NAME);
  assert.equal(taskNameForChannel(""), BASE_TASK_NAME);
  assert.equal(taskNameForChannel("development"), `${BASE_TASK_NAME}.development`);
  assert.deepEqual(allManagedTaskNames(), [
    BASE_TASK_NAME,
    `${BASE_TASK_NAME}.staging`,
    `${BASE_TASK_NAME}.development`,
  ]);
});

test("the task command quotes paths with spaces and always launches hidden", () => {
  const packaged = getPackagedLaunchSpec({
    execPath: "C:\\\\Program Files\\\\Overlay\\\\Overlay.exe",
    argv: ["C:\\\\Program Files\\\\Overlay\\\\Overlay.exe"],
    defaultApp: false,
    hidden: true,
  });
  assert.deepEqual(packaged.args, [HIDDEN_LAUNCH_FLAG]);
  const command = buildTaskCommand({ execPath: packaged.execPath, appArgs: packaged.args });
  assert.equal(command, `"C:\\\\Program Files\\\\Overlay\\\\Overlay.exe" --hidden`);

  const dev = getPackagedLaunchSpec({
    execPath: "C:\\\\path\\\\electron.exe",
    argv: ["electron.exe", "C:\\\\E\\\\Github Repos\\\\Overlay-wt-v2"],
    defaultApp: true,
    hidden: true,
  });
  assert.deepEqual(dev.args, ["C:\\\\E\\\\Github Repos\\\\Overlay-wt-v2", HIDDEN_LAUNCH_FLAG]);
});

test("schtasks create uses a highest-privileges on-logon task", () => {
  const args = buildCreateArgs({
    taskName: BASE_TASK_NAME,
    execPath: "C:\\\\Overlay\\\\Overlay.exe",
    appArgs: [HIDDEN_LAUNCH_FLAG],
  });
  assert.deepEqual(args, [
    "/Create",
    "/TN",
    BASE_TASK_NAME,
    "/TR",
    "C:\\\\Overlay\\\\Overlay.exe --hidden",
    "/SC",
    "ONLOGON",
    "/RL",
    "HIGHEST",
    "/IT",
    "/F",
  ]);
  assert.deepEqual(buildDeleteArgs(BASE_TASK_NAME), ["/Delete", "/TN", BASE_TASK_NAME, "/F"]);
});

test("query parsing treats a missing task as absent without throwing", () => {
  assert.deepEqual(
    parseQueryResult({
      error: { message: "ERROR: The system cannot find the file specified." },
      stdout: "",
      stderr: "",
    }),
    { exists: false }
  );
  assert.equal(
    parseQueryResult({ error: null, stdout: "TaskName: com.ridhamjain.overlay\n" }).exists,
    true
  );
});

test("an elevated relaunch does not replay a hidden login launch", () => {
  const command = buildRelaunchPowerShell({
    execPath: "C:\\\\Overlay\\\\Overlay.exe",
    argv: ["C:\\\\Overlay\\\\Overlay.exe", "--hidden", "something"],
  });
  assert.match(command, /Start-Process -FilePath 'C:\\\\Overlay\\\\Overlay.exe'/);
  assert.match(command, /-ArgumentList 'something'/);
  assert.equal(command.includes("--hidden"), false);
  assert.match(command, /-Verb RunAs$/);
});

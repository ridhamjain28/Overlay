// Launch at login, for ipcHandlers.js and main.js. setLoginItemSettings covers
// macOS and Windows; on Linux it does nothing, so an XDG autostart entry stands in
// (linuxAutostart.js). Decisions live in autoStartPolicy.js.
//
// On Windows, "Run as administrator" plus launch-at-login cannot use a plain
// Run-key login item (those start unelevated). In that case Overlay registers
// a Task Scheduler on-logon task with highest privileges instead.

const { app } = require("electron");
const linuxAutostart = require("./linuxAutostart");
const {
  getLoginItemArgs,
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
} = require("./autoStartPolicy");
const {
  createWindowsAdminStart,
  shouldUseLogonTask,
  taskNameForChannel,
  getPackagedLaunchSpec,
} = require("./windowsAdminStart");

const isLinux = () => process.platform === "linux";

let getRunAsAdmin = () => false;
const windowsAdminStart = createWindowsAdminStart();

function configureAutoStart(options = {}) {
  if (typeof options.getRunAsAdmin === "function") {
    getRunAsAdmin = options.getRunAsAdmin;
  }
}

function currentTaskName() {
  return taskNameForChannel(process.env.OPENWHISPR_CHANNEL);
}

function currentLaunchSpec() {
  return getPackagedLaunchSpec({
    execPath: process.execPath,
    argv: process.argv,
    defaultApp: !!process.defaultApp,
    hidden: true,
  });
}

function readLoginItemSettings() {
  return app.getLoginItemSettings({ args: getLoginItemArgs(process.platform) });
}

function writeLoginItem(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: getLoginItemArgs(process.platform),
  });
}

function loginItemEnabled() {
  return resolveAutoStartState({
    platform: process.platform,
    loginItemSettings: readLoginItemSettings(),
  }).enabled;
}

// { enabled, requiresApproval } — requiresApproval is macOS-only.
async function getAutoStartState() {
  if (isLinux()) {
    return { enabled: linuxAutostart.isAutostartEnabled(), requiresApproval: false };
  }
  if (process.platform === "win32" && getRunAsAdmin()) {
    const enabled = await windowsAdminStart.hasLogonTask(currentTaskName());
    return { enabled, requiresApproval: false };
  }
  return resolveAutoStartState({
    platform: process.platform,
    loginItemSettings: readLoginItemSettings(),
  });
}

async function setAutoStartEnabled(enabled) {
  if (isLinux()) {
    linuxAutostart.setAutostartEnabled(enabled);
    return { success: true };
  }

  if (
    shouldUseLogonTask({
      platform: process.platform,
      runAsAdmin: getRunAsAdmin(),
      autoStartEnabled: enabled,
    })
  ) {
    const launch = currentLaunchSpec();
    const result = await windowsAdminStart.setLogonTask({
      enabled: true,
      taskName: currentTaskName(),
      execPath: launch.execPath,
      appArgs: launch.args,
    });
    if (!result.success) return result;
    writeLoginItem(false);
    return { success: true };
  }

  if (process.platform === "win32") {
    await windowsAdminStart.setLogonTask({
      enabled: false,
      taskName: currentTaskName(),
    });
  }
  writeLoginItem(enabled);
  return { success: true };
}

// After the Run-as-administrator setting changes: move between a login item
// and a highest-privileges logon task when Start with Windows is on, and tell
// the caller whether this process still needs to relaunch elevated.
async function applyRunAsAdminChange(enabled) {
  if (process.platform !== "win32") {
    return { success: true, needsElevation: false };
  }

  const loginOn = loginItemEnabled();
  const taskOn = await windowsAdminStart.hasLogonTask(currentTaskName());
  const autoStartOn = loginOn || taskOn;

  if (enabled) {
    if (autoStartOn) {
      const launch = currentLaunchSpec();
      const result = await windowsAdminStart.setLogonTask({
        enabled: true,
        taskName: currentTaskName(),
        execPath: launch.execPath,
        appArgs: launch.args,
      });
      if (result.success) {
        writeLoginItem(false);
      } else if (!windowsAdminStart.isElevated()) {
        return { success: true, needsElevation: true };
      } else {
        return result;
      }
    }
    return { success: true, needsElevation: !windowsAdminStart.isElevated() };
  }

  await windowsAdminStart.setLogonTask({
    enabled: false,
    taskName: currentTaskName(),
  });
  if (autoStartOn) writeLoginItem(true);
  return { success: true, needsElevation: false };
}

function wasLaunchedAtLoginHidden() {
  return wasLaunchedHidden({
    platform: process.platform,
    argv: process.argv,
    loginItemSettings: process.platform === "darwin" ? app.getLoginItemSettings() : null,
  });
}

// Repairs an entry that still exists but no longer starts this executable, or
// starts it without the flag that sends it to the tray. True when it rewrote one.
async function syncAutoStartEntry() {
  if (isLinux()) return linuxAutostart.syncAutostartEntry();

  if (process.platform === "win32" && getRunAsAdmin()) {
    const taskOn = await windowsAdminStart.hasLogonTask(currentTaskName());
    if (!taskOn) return false;
    const launch = currentLaunchSpec();
    await windowsAdminStart.setLogonTask({
      enabled: true,
      taskName: currentTaskName(),
      execPath: launch.execPath,
      appArgs: launch.args,
    });
    writeLoginItem(false);
    return true;
  }

  const loginItemSettings = readLoginItemSettings();
  if (!needsHiddenFlagMigration({ platform: process.platform, loginItemSettings })) return false;

  writeLoginItem(true);
  return true;
}

function relaunchElevated(options = {}) {
  return windowsAdminStart.relaunchElevated({
    execPath: process.execPath,
    argv: process.argv,
    afterSpawn: () => app.quit(),
    ...options,
  });
}

module.exports = {
  configureAutoStart,
  getAutoStartState,
  setAutoStartEnabled,
  applyRunAsAdminChange,
  wasLaunchedAtLoginHidden,
  syncAutoStartEntry,
  isElevated: () => windowsAdminStart.isElevated(),
  relaunchElevated,
};

// Windows-only elevation and "Start with Windows" logon-task helpers.
// Policy is kept free of Electron so it can be unit-tested. The app installer
// stays per-user (asInvoker); this only elevates a running instance the user
// opted into, and registers a highest-privileges logon task when Start with
// Windows is also on.

const { execFile, execFileSync, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const BASE_TASK_NAME = "com.ridhamjain.overlay";
const HIDDEN_LAUNCH_FLAG = "--hidden";
const TASK_CHANNELS = ["", "staging", "development"];

function taskNameForChannel(channel) {
  const name = String(channel || "production").trim().toLowerCase();
  if (!name || name === "production") return BASE_TASK_NAME;
  return `${BASE_TASK_NAME}.${name}`;
}

function allManagedTaskNames() {
  return TASK_CHANNELS.map((suffix) =>
    suffix ? `${BASE_TASK_NAME}.${suffix}` : BASE_TASK_NAME
  );
}

function shouldUseLogonTask({ platform, runAsAdmin, autoStartEnabled }) {
  return platform === "win32" && !!runAsAdmin && !!autoStartEnabled;
}

function quoteCmdArg(value) {
  const text = String(value ?? "");
  if (text === "") return '""';
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function buildTaskCommand({ execPath, appArgs = [] }) {
  const parts = [quoteCmdArg(execPath), ...appArgs.map(quoteCmdArg)];
  return parts.join(" ").trim();
}

function getPackagedLaunchSpec({ execPath, argv, defaultApp, hidden = true } = {}) {
  const args = [];
  const isUnpackaged =
    defaultApp ||
    /(^|[\\/])electron(\.exe)?$/i.test(String(execPath || ""));
  if (isUnpackaged) {
    const appPath = Array.isArray(argv) ? argv[1] : null;
    if (appPath && !appPath.startsWith("-")) args.push(appPath);
  }
  if (hidden) args.push(HIDDEN_LAUNCH_FLAG);
  return { execPath, args };
}

function buildCreateArgs({ taskName, execPath, appArgs = [] }) {
  return [
    "/Create",
    "/TN",
    taskName,
    "/TR",
    buildTaskCommand({ execPath, appArgs }),
    "/SC",
    "ONLOGON",
    "/RL",
    "HIGHEST",
    "/IT",
    "/F",
  ];
}

function buildDeleteArgs(taskName) {
  return ["/Delete", "/TN", taskName, "/F"];
}

function buildQueryArgs(taskName) {
  return ["/Query", "/TN", taskName, "/FO", "LIST"];
}

function parseQueryResult({ error, stdout, stderr }) {
  if (error) {
    const detail = `${error.message || ""} ${stderr || ""} ${stdout || ""}`;
    if (/cannot find|ERROR: The system cannot find|does not exist/i.test(detail)) {
      return { exists: false };
    }
    return { exists: false, error: "query_failed" };
  }
  const text = `${stdout || ""}\n${stderr || ""}`;
  return { exists: /TaskName\s*:/i.test(text) };
}

function quotePowerShell(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function buildRelaunchPowerShell({ execPath, argv }) {
  const appArgs = (Array.isArray(argv) ? argv.slice(1) : []).filter(
    (arg) => arg !== HIDDEN_LAUNCH_FLAG
  );
  const argumentList = appArgs.length
    ? ` -ArgumentList ${appArgs.map(quotePowerShell).join(",")}`
    : "";
  return `Start-Process -FilePath ${quotePowerShell(execPath)}${argumentList} -Verb RunAs`;
}

function createWindowsAdminStart(deps = {}) {
  const execFileFn = deps.execFile || execFileAsync;
  const execFileSyncFn = deps.execFileSync || execFileSync;
  const spawnFn = deps.spawn || spawn;
  const platform = deps.platform || process.platform;

  async function runSchtasks(args) {
    try {
      const result = await execFileFn("schtasks", args, {
        windowsHide: true,
        timeout: 15000,
        encoding: "utf8",
      });
      return { stdout: result.stdout || "", stderr: result.stderr || "" };
    } catch (error) {
      return {
        error,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
      };
    }
  }

  function isElevated() {
    if (platform !== "win32") return false;
    try {
      execFileSyncFn("net", ["session"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function hasLogonTask(taskName) {
    const result = await runSchtasks(buildQueryArgs(taskName));
    return parseQueryResult(result).exists === true;
  }

  async function setLogonTask({ enabled, taskName, execPath, appArgs }) {
    if (!enabled) {
      const result = await runSchtasks(buildDeleteArgs(taskName));
      if (result.error && parseQueryResult(result).error === "query_failed") {
        return { success: false, error: "failed_to_remove_logon_task" };
      }
      return { success: true };
    }
    const result = await runSchtasks(buildCreateArgs({ taskName, execPath, appArgs }));
    if (result.error) return { success: false, error: "failed_to_create_logon_task" };
    return { success: true };
  }

  async function removeManagedLogonTasks() {
    const results = [];
    for (const name of allManagedTaskNames()) {
      results.push(await setLogonTask({ enabled: false, taskName: name }));
    }
    return results;
  }

  function relaunchElevated({ execPath, argv, afterSpawn } = {}) {
    if (platform !== "win32") return Promise.resolve({ success: false, error: "not_windows" });
    const command = buildRelaunchPowerShell({
      execPath: execPath || process.execPath,
      argv: argv || process.argv,
    });
    // Wait for Start-Process to finish (UAC accepted or cancelled) before
    // quitting this process. Quitting immediately would close the app even
    // when the user declines elevation.
    return new Promise((resolve) => {
      const child = spawnFn(
        "powershell.exe",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", command],
        { detached: false, stdio: "ignore", windowsHide: true }
      );
      child.on("error", () => resolve({ success: false, error: "elevation_failed", relaunched: false }));
      child.on("exit", (code) => {
        if (code === 0) {
          if (typeof afterSpawn === "function") afterSpawn();
          resolve({ success: true, relaunched: true });
          return;
        }
        resolve({ success: false, error: "elevation_declined", relaunched: false });
      });
    });
  }

  return {
    isElevated,
    hasLogonTask,
    setLogonTask,
    removeManagedLogonTasks,
    relaunchElevated,
  };
}

module.exports = {
  BASE_TASK_NAME,
  HIDDEN_LAUNCH_FLAG,
  taskNameForChannel,
  allManagedTaskNames,
  shouldUseLogonTask,
  quoteCmdArg,
  buildTaskCommand,
  getPackagedLaunchSpec,
  buildCreateArgs,
  buildDeleteArgs,
  buildQueryArgs,
  parseQueryResult,
  quotePowerShell,
  buildRelaunchPowerShell,
  createWindowsAdminStart,
};

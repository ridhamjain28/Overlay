// Overlay Command mode: execute one allowlisted desktop action.
// The main process is the only place this runs. Destructive / shell work is
// gated here so a model cannot skip the confirmation step.

const { COMMAND_ACTIONS, formatIntentForConfirm } = require("./intentParser");
const { locateGuideTarget } = require("./guideLocator");
const { resolveApp, listShortcuts, startMenuDirs, isBlockedApp, normalizeName, BUILTIN_APPS } =
  require("../systemActions");

const TRUSTED_ACTIONS = new Set(["open_app", "open_url", "type_text", "guide"]);
const ALWAYS_CONFIRM_ACTIONS = new Set(["run_command"]);

const MAX_COMMAND_LENGTH = 500;
const MAX_TYPE_LENGTH = 8000;
const COMMAND_TIMEOUT_MS = 20000;
const MAX_OUTPUT = 4000;

// Patterns that must never be auto-run, and are refused even after confirm
// when they are obviously destructive.
const BLOCKED_COMMAND_PATTERNS = [
  /\b(format|diskpart|bcdedit|bootrec|chkdsk\s+\/[fp])\b/i,
  /\b(shutdown|restart-computer|stop-computer|shutdown\.exe)\b/i,
  /\b(reg\s+(delete|add|import)|regedit|regedt32)\b/i,
  /\b(rmdir\s+\/s|rd\s+\/s|del\s+\/s|erase\s+\/s)\b/i,
  /\bremove-item\b[^;\n]*(-recurse|-r\b)/i,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|--recursive)\b/i,
  /\b(mkfs|dd\s+if=|cipher\s+\/w)\b/i,
  /\b(net\s+user|net\s+localgroup|net\s+share)\b/i,
  /\b(invoke-expression|\biex\b|invoke-webrequest\b.*\|\s*iex)\b/i,
  /\bdownloadstring\b/i,
  /\bstart-bitstransfer\b/i,
  /\b(sc\s+(delete|create|config)|stop-service)\b/i,
];

function needsConfirmation(action, { autoRunTrusted = false } = {}) {
  if (ALWAYS_CONFIRM_ACTIONS.has(action)) return true;
  if (TRUSTED_ACTIONS.has(action) && autoRunTrusted) return false;
  return COMMAND_ACTIONS.includes(action);
}

function isBlockedCommand(command) {
  const c = String(command || "");
  return BLOCKED_COMMAND_PATTERNS.some((re) => re.test(c));
}

function clampString(value, max) {
  const s = String(value || "");
  return s.length > max ? s.slice(0, max) : s;
}

function validateCommandRequest(request) {
  if (!request || typeof request !== "object") {
    return { ok: false, error: "Invalid request", code: "NOT_ALLOWED" };
  }
  const action = typeof request.action === "string" ? request.action.trim() : "";
  if (!COMMAND_ACTIONS.includes(action)) {
    return {
      ok: false,
      error: `Action "${action || "(none)"}" is not allowed. Allowed: ${COMMAND_ACTIONS.join(", ")}`,
      code: "NOT_ALLOWED",
    };
  }
  const args = request.args && typeof request.args === "object" ? { ...request.args } : {};
  if (action === "open_app") {
    const app = normalizeName(args.app || request.app);
    if (!app || app.length > 80) return { ok: false, error: "open_app needs an app name", code: "NOT_ALLOWED" };
    if (isBlockedApp(app)) return { ok: false, error: `Opening "${app}" is not allowed`, code: "NOT_ALLOWED" };
    args.app = app;
  }
  if (action === "open_url") {
    let url;
    try {
      url = new URL(String(args.url || request.url || "").trim());
    } catch {
      return { ok: false, error: "open_url needs a full http(s) link", code: "NOT_ALLOWED" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "Only http and https links can be opened", code: "NOT_ALLOWED" };
    }
    args.url = url.toString();
  }
  if (action === "run_command") {
    const command = clampString(args.command || request.command, MAX_COMMAND_LENGTH).trim();
    if (!command) return { ok: false, error: "run_command needs a command", code: "NOT_ALLOWED" };
    if (isBlockedCommand(command)) {
      return {
        ok: false,
        error: "That command is blocked because it looks destructive or unsafe",
        code: "BLOCKED",
      };
    }
    args.command = command;
  }
  if (action === "type_text") {
    const text = clampString(args.text ?? request.text, MAX_TYPE_LENGTH);
    if (!String(text).length) return { ok: false, error: "type_text needs some text", code: "NOT_ALLOWED" };
    args.text = text;
  }
  if (action === "guide") {
    const target = String(args.target || request.target || "").trim();
    if (!target || target.length > 80) {
      return { ok: false, error: "guide needs the name of a button or control", code: "NOT_ALLOWED" };
    }
    args.target = target;
  }
  return { ok: true, action, args };
}

function confirmMessage(action, args) {
  return formatIntentForConfirm({ action, args });
}

function createCommandDispatcher(deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    execFile,
    openPath,
    openExternal,
    confirm, // (message) => Promise<boolean>
    pasteText, // (text, options) => Promise
    locateGuide = locateGuideTarget,
    showHighlight, // (bounds) => void
    fsImpl = require("fs"),
    getAutoRunTrusted = () => false,
    isEnabled = () => true,
  } = deps;

  async function perform(request, options = {}) {
    if (!isEnabled()) {
      return { success: false, error: "Command mode is turned off", code: "DISABLED" };
    }
    const check = validateCommandRequest(request);
    if (!check.ok) return { success: false, error: check.error, code: check.code };
    const { action, args } = check;
    const autoRunTrusted = options.autoRunTrusted === true || getAutoRunTrusted() === true;
    const alreadyConfirmed = options.confirmed === true;
    const mustConfirm = needsConfirmation(action, { autoRunTrusted }) && !alreadyConfirmed;
    // Shell commands always confirm unless the caller already got a user Yes
    // *and* we still re-check here for unconfirmed IPC.
    if (action === "run_command" && !alreadyConfirmed) {
      const allowed = typeof confirm === "function" ? await confirm(confirmMessage(action, args)) : false;
      if (!allowed) return { success: false, error: "You cancelled this command", code: "CANCELLED" };
    } else if (mustConfirm) {
      const allowed = typeof confirm === "function" ? await confirm(confirmMessage(action, args)) : false;
      if (!allowed) return { success: false, error: "You cancelled this command", code: "CANCELLED" };
    }

    try {
      switch (action) {
        case "open_url":
          await openExternal(args.url);
          return { success: true, message: `Opened ${args.url}`, action, args };
        case "open_app": {
          if (platform !== "win32") {
            return {
              success: false,
              error: "Opening apps this way is only available on Windows",
              code: "UNSUPPORTED",
            };
          }
          const app = resolveApp(args.app, {
            shortcuts: listShortcuts(startMenuDirs(env), fsImpl),
          });
          if (!app) {
            return {
              success: false,
              error: `I could not find an app named "${args.app}"`,
              code: "NOT_FOUND",
            };
          }
          if (app.type === "uri" || /^[a-z][a-z0-9+.-]*:/i.test(app.target)) {
            await openExternal(app.target);
          } else if (app.type === "exe") {
            await execFile(app.target, [], { windowsHide: false, timeout: 5000, detached: true });
          } else if (typeof openPath === "function") {
            const error = await openPath(app.target);
            if (error) throw new Error(error);
          } else {
            await execFile(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                `Start-Process -FilePath ${JSON.stringify(app.target)}`,
              ],
              { windowsHide: true, timeout: 8000 }
            );
          }
          return { success: true, message: `Opened ${app.label}`, action, args };
        }
        case "run_command": {
          if (platform !== "win32") {
            return {
              success: false,
              error: "Running shell commands is only available on Windows",
              code: "UNSUPPORTED",
            };
          }
                    let stdout = "";
          let stderr = "";
          try {
            const result = await execFile("cmd.exe", ["/d", "/c", args.command], {
              windowsHide: true,
              timeout: COMMAND_TIMEOUT_MS,
              encoding: "utf8",
              maxBuffer: 1024 * 1024,
              env,
              cwd: env.USERPROFILE || env.HOME || undefined,
            });
            stdout = result && result.stdout != null ? String(result.stdout) : String(result || "");
            stderr = result && result.stderr != null ? String(result.stderr) : "";
          } catch (error) {
            stdout = error.stdout != null ? String(error.stdout) : "";
            stderr = error.stderr != null ? String(error.stderr) : error.message;
            const output = clampString([stdout, stderr].filter(Boolean).join("\n").trim(), MAX_OUTPUT);
            return {
              success: false,
              error: output || `Command failed: ${error.message}`,
              code: "FAILED",
              action,
              args,
            };
          }
          const output = clampString([stdout, stderr].filter(Boolean).join("\n").trim(), MAX_OUTPUT);
          return {
            success: true,
            message: output ? `Command finished:\n${output}` : "Command finished with no output",
            action,
            args,
          };
        }
        case "type_text": {
          if (typeof pasteText !== "function") {
            return { success: false, error: "Typing into apps is not available", code: "FAILED" };
          }
          await pasteText(args.text, { restoreClipboard: true, silentAccessibilityCheck: true });
          return { success: true, message: "Typed into the focused field", action, args };
        }
        case "guide": {
          const found = await locateGuide(args.target, { platform, execFile });
          if (found?.bounds && typeof showHighlight === "function") {
            try {
              showHighlight(found.bounds);
            } catch {
              // Highlight is best-effort.
            }
          }
          return {
            success: found?.ok !== false,
            message: found?.instruction || "I could not inspect the screen.",
            action,
            args,
            bounds: found?.bounds || null,
            windowTitle: found?.windowTitle,
          };
        }
        default:
          return { success: false, error: "Not allowed", code: "NOT_ALLOWED" };
      }
    } catch (error) {
      return { success: false, error: `Action failed: ${error.message}`, code: "FAILED", action, args };
    }
  }

  return { perform, needsConfirmation, validateCommandRequest };
}

module.exports = {
  TRUSTED_ACTIONS,
  ALWAYS_CONFIRM_ACTIONS,
  BLOCKED_COMMAND_PATTERNS,
  MAX_COMMAND_LENGTH,
  needsConfirmation,
  isBlockedCommand,
  validateCommandRequest,
  confirmMessage,
  createCommandDispatcher,
  BUILTIN_APPS,
};

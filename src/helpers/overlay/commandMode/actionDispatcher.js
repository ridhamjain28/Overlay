// Overlay Command mode: execute one allowlisted desktop action.
// The main process is the only place this runs. Destructive / shell work is
// gated here so a model cannot skip the confirmation step.

const { COMMAND_ACTIONS, formatIntentForConfirm, containsCommandConnector } = require("./intentParser");
const { locateGuideTarget } = require("./guideLocator");
const { resolveApp, listShortcuts, startMenuDirs, isBlockedApp, normalizeName, BUILTIN_APPS } =
  require("../systemActions");
const {
  browserProductFromName,
  resolveBrowserLaunch,
} = require("../chromiumProfile");
const { buildGmailComposeUrl } = require("./webApps");
const { fillActionTemplate } = require("../appSkillTemplates");
const {
  findPaths,
  formatFindOutcome,
  isExecutablePath,
  explorerSearchMsUrl,
  defaultKnownRoots,
} = require("./findPath");

const TRUSTED_ACTIONS = new Set(["open_app", "open_url", "type_text", "compose_text", "compose_email", "guide", "app_action", "find_path", "open_path"]);
const ALWAYS_CONFIRM_ACTIONS = new Set(["run_command"]);
const PLAN_STEP_DELAY_MS = 1500;
const APP_LAUNCH_GRACE_MS = 300;

const MAX_COMMAND_LENGTH = 500;
const MAX_TYPE_LENGTH = 8000;
const MAX_COMPOSE_PROMPT_LENGTH = 4000;
const MAX_COMPOSE_OUTPUT_LENGTH = 32000;
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

function needsConfirmation(action, { autoRunTrusted = false, args } = {}) {
  if (ALWAYS_CONFIRM_ACTIONS.has(action)) return true;
  if (action === "open_path" && args && args.run && isExecutablePath(args.path)) return true;
  if (TRUSTED_ACTIONS.has(action) && autoRunTrusted) return false;
  return COMMAND_ACTIONS.includes(action);
}

function isBlockedCommand(command) {
  const c = String(command || "");
  return BLOCKED_COMMAND_PATTERNS.some((re) => re.test(c));
}

function isExplorerExecutable(file) {
  const base = String(file || "").replace(/^.*[\\/]/, "").toLowerCase();
  return base === "explorer.exe" || base === "explorer";
}

function isSpawnFailure(error) {
  if (!error) return false;
  const code = error.code;
  return typeof code === "string" && /^(ENOENT|EACCES|EPERM|ENOTDIR)$/i.test(code);
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
    if (containsCommandConnector(app)) {
      return { ok: false, error: "open_app needs a plain app name, not a combined command", code: "NOT_ALLOWED" };
    }
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
    const browser = String(args.browser || args.app || request.browser || "").trim();
    if (browser && browser.length <= 40 && !/[/\\:]/.test(browser)) {
      args.browser = browser;
    }
  }
  if (action === "find_path") {
    const name = String(args.name || request.name || "").trim();
    if (!name || name.length > 200) return { ok: false, error: "find_path needs a name", code: "NOT_ALLOWED" };
    args.name = name;
    args.kind = /^(folder|file|any)$/i.test(String(args.kind || "")) ? String(args.kind).toLowerCase() : "any";
    if (args.within) args.within = String(args.within).trim();
  }
  if (action === "open_path") {
    const filePath = String(args.path || request.path || "").trim();
    if (args.searchMs || args.searchQuery) {
      args.searchMs = true;
      args.searchQuery = String(args.searchQuery || "").trim();
      if (!args.searchQuery) return { ok: false, error: "Explorer search needs a query", code: "NOT_ALLOWED" };
    } else if (!filePath || filePath.length > 500) {
      return { ok: false, error: "open_path needs a file or folder path", code: "NOT_ALLOWED" };
    } else {
      args.path = filePath;
    }
    if (args.run) args.run = true;
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
  if (action === "compose_text") {
    const prompt = clampString(args.prompt || request.prompt, MAX_COMPOSE_PROMPT_LENGTH).trim();
    if (!prompt) return { ok: false, error: "compose_text needs a writing request", code: "NOT_ALLOWED" };
    args.prompt = prompt;
  }
  if (action === "compose_email") {
    const to = clampString(args.to || request.to, 320).trim();
    const subject = clampString(args.subject || request.subject, 300).trim();
    const prompt = clampString(args.prompt || request.prompt, MAX_COMPOSE_PROMPT_LENGTH).trim();
    if (!to && !prompt) {
      return { ok: false, error: "compose_email needs a recipient or a writing request", code: "NOT_ALLOWED" };
    }
    if (to) args.to = to;
    if (subject) args.subject = subject;
    args.prompt = prompt || `Write an email${to ? " to " + to : ""}${subject ? " about " + subject : ""}. Output only the email body as plain text, with no subject line and no preamble.`;
  }
  if (action === "guide") {
    const target = String(args.target || request.target || "").trim();
    if (!target || target.length > 80) {
      return { ok: false, error: "guide needs the name of a button or control", code: "NOT_ALLOWED" };
    }
    args.target = target;
  }
  if (action === "app_action") {
    const appId = String(args.appId || request.appId || request.app || "").trim();
    const actionId = String(args.actionId || request.actionId || "").trim();
    if (!appId || !actionId) {
      return { ok: false, error: "app_action needs an appId and actionId", code: "NOT_ALLOWED" };
    }
    args.appId = appId;
    args.actionId = actionId;
    const params = args.params || request.params;
    args.params = params && typeof params === "object" && !Array.isArray(params) ? params : {};
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
    stepDelayMs = PLAN_STEP_DELAY_MS,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    composeText, // (prompt, { signal, onToken }) => Promise<string>
    focusApp, // (name) => Promise
    onProgress, // (phase) => void
    getAppSkill, // (appId) => skill
    sendKeys, // (combo) => Promise
    searchIndex, // ({ name, kind, roots }) => Promise<matches>
  } = deps;

  async function launchDetached(file, args = []) {
    let spawnError = null;
    const launched = Promise.resolve(
      execFile(file, args, { windowsHide: false, detached: true })
    ).then(
      () => {},
      (error) => {
        // explorer.exe (and other GUI apps) often exit 1 after opening a window.
        // Only a failed spawn (not found / not allowed) is a real error.
        if (isSpawnFailure(error)) spawnError = error;
      }
    );
    await Promise.race([
      launched,
      new Promise((resolve) => {
        setTimeout(resolve, APP_LAUNCH_GRACE_MS);
      }),
    ]);
    if (spawnError) throw spawnError;
  }

  async function launchExplorer(explorerArgs = []) {
    const exe = "explorer.exe";
    await launchDetached(exe, explorerArgs);
    return { success: true, exe, args: explorerArgs };
  }

  async function launchBrowser(product, { url, executablePath } = {}) {
    if (platform !== "win32" || !product || product === "default") return false;
    const launched = resolveBrowserLaunch({
      product,
      url,
      env,
      fsImpl,
      executablePath,
    });
    if (!launched) return false;
    await launchDetached(launched.exe, launched.args);
    return true;
  }

  async function performPlan(request, options = {}) {
    const steps = Array.isArray(request?.steps) ? request.steps : [];
    if (!steps.length) {
      return { success: false, error: "That command has no steps to run", code: "NOT_ALLOWED" };
    }
    const validated = [];
    for (const step of steps) {
      const check = validateCommandRequest(step);
      if (!check.ok) return { success: false, error: check.error, code: check.code };
      validated.push({ action: check.action, args: check.args });
    }
    const autoRunTrusted = options.autoRunTrusted === true || getAutoRunTrusted() === true;
    const alreadyConfirmed = options.confirmed === true;
    const planIntent = { action: "plan", args: {}, steps: validated };
    const mustConfirm =
      validated.some((step) => needsConfirmation(step.action, { autoRunTrusted })) && !alreadyConfirmed;
    if (mustConfirm) {
      const allowed =
        typeof confirm === "function" ? await confirm(formatIntentForConfirm(planIntent)) : false;
      if (!allowed) return { success: false, error: "You cancelled this command", code: "CANCELLED" };
    }
    const delay = Number.isFinite(options.stepDelayMs) ? options.stepDelayMs : stepDelayMs;
    const messages = [];
    let lastOpenedLabel = "";
    let focusReady = Promise.resolve();
    for (let i = 0; i < validated.length; i += 1) {
      const step = validated[i];
      const openedBefore = step.action === "compose_text" && lastOpenedLabel;
      // Start composing immediately after opening an app — do not wait on the LLM
      // before the app launches, and do not delay the model call by the focus wait.
      if (i > 0 && delay > 0 && step.action !== "compose_text" && !(step.action === "type_text" && lastOpenedLabel)) {
        await wait(delay);
      }
      const result = await perform(step, {
        ...options,
        confirmed: true,
        autoRunTrusted,
        focusLabel: openedBefore ? lastOpenedLabel : options.focusLabel,
        focusReady: openedBefore ? focusReady : undefined,
      });
      if (!result.success) return result;
      if (step.action === "open_app") {
        lastOpenedLabel = result.label || step.args.app || lastOpenedLabel;
        focusReady = delay > 0 ? wait(delay) : Promise.resolve();
      }
      if (result.message) messages.push(result.message);
    }
    return {
      success: true,
      message: messages.join("\n") || "Done",
      action: "plan",
      args: {},
      steps: validated,
    };
  }

  async function perform(request, options = {}) {
    if (!isEnabled() && options.allowWhenDisabled !== true) {
      return { success: false, error: "Command mode is turned off", code: "DISABLED" };
    }
    if (request?.action === "plan" || Array.isArray(request?.steps)) {
      return performPlan(request, options);
    }
    const check = validateCommandRequest(request);
    if (!check.ok) return { success: false, error: check.error, code: check.code };
    const { action, args } = check;
    const autoRunTrusted = options.autoRunTrusted === true || getAutoRunTrusted() === true;
    const alreadyConfirmed = options.confirmed === true;
    const mustConfirm = needsConfirmation(action, { autoRunTrusted }) && !alreadyConfirmed;
    const skillForAction =
      action === "app_action" && typeof getAppSkill === "function" ? getAppSkill(args.appId) : null;
    const skillAction =
      skillForAction && (skillForAction.actions || []).find((item) => item.id === args.actionId);
    if (action === "app_action" && skillAction?.risk === "confirm" && !alreadyConfirmed) {
      const allowed = typeof confirm === "function" ? await confirm(confirmMessage(action, args)) : false;
      if (!allowed) return { success: false, error: "You cancelled this command", code: "CANCELLED" };
    } else if (action === "run_command" && !alreadyConfirmed) {
      const allowed = typeof confirm === "function" ? await confirm(confirmMessage(action, args)) : false;
      if (!allowed) return { success: false, error: "You cancelled this command", code: "CANCELLED" };
    } else if (mustConfirm) {
      const allowed = typeof confirm === "function" ? await confirm(confirmMessage(action, args)) : false;
      if (!allowed) return { success: false, error: "You cancelled this command", code: "CANCELLED" };
    }

    try {
      switch (action) {
        case "open_url": {
          const preferred = browserProductFromName(args.browser || args.app);
          let opened = false;
          if (preferred === "default") {
            await openExternal(args.url);
            opened = true;
          } else if (preferred) {
            opened = await launchBrowser(preferred, { url: args.url });
          }
          if (!opened) {
            opened =
              (await launchBrowser("chrome", { url: args.url })) ||
              (await launchBrowser("edge", { url: args.url })) ||
              (await launchBrowser("brave", { url: args.url }));
          }
          if (!opened) await openExternal(args.url);
          return { success: true, message: `Opened ${args.url}`, action, args };
        }
        case "open_app": {
          if (platform !== "win32") {
            return {
              success: false,
              error: "Opening apps this way is only available on Windows",
              code: "UNSUPPORTED",
            };
          }
          const product = browserProductFromName(args.app);
          if (product && product !== "default" && (await launchBrowser(product))) {
            return { success: true, message: `Opened ${args.app}`, action, args, label: args.app };
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
            // Launch and return at once: the app keeps running on its own, so only an
            // immediate failure (e.g. not found) is reported. No kill timeout, which
            // would close the app we just opened.
            await launchDetached(app.target, []);
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
          return { success: true, message: `Opened ${app.label}`, action, args, label: app.label };
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
          if (typeof options.focusReady?.then === "function") await options.focusReady;
          if (options.focusLabel && typeof focusApp === "function") {
            try { await focusApp(options.focusLabel); } catch { /* best-effort */ }
          }
          await pasteText(args.text, { restoreClipboard: true, silentAccessibilityCheck: true });
          return { success: true, message: "Typed into the focused field", action, args };
        }
        case "compose_text": {
          if (typeof composeText !== "function") {
            return { success: false, error: "Writing is not available", code: "FAILED" };
          }
          if (typeof pasteText !== "function") {
            return { success: false, error: "Typing into apps is not available", code: "FAILED" };
          }
          if (options.signal?.aborted) {
            return { success: false, error: "You cancelled this command", code: "CANCELLED" };
          }
          const emitProgress = typeof options.onProgress === "function" ? options.onProgress : onProgress;
          if (typeof emitProgress === "function") {
            try { emitProgress("writing"); } catch { /* ignore */ }
          }
          let generated = "";
          try {
            const write = typeof options.composeText === "function" ? options.composeText : composeText;
            if (typeof write !== "function") {
              return { success: false, error: "Writing is not available", code: "FAILED" };
            }
            generated = await write(args.prompt, {
              signal: options.signal,
              onToken: options.onToken,
            });
          } catch (error) {
            if (error?.code === "TIMEOUT" || error?.name === "AbortError" || options.signal?.aborted) {
              return {
                success: false,
                error: options.signal?.aborted
                  ? "You cancelled this command"
                  : "Couldn't write that in time — nothing was typed",
                code: options.signal?.aborted ? "CANCELLED" : "TIMEOUT",
              };
            }
            return {
              success: false,
              error: "Couldn't write that — nothing was typed",
              code: "COMPOSE_FAILED",
            };
          }
          const text = clampString(String(generated || "").trim(), MAX_COMPOSE_OUTPUT_LENGTH);
          if (!text) {
            return {
              success: false,
              error: "Couldn't write that — nothing was typed",
              code: "COMPOSE_FAILED",
            };
          }
          if (typeof options.focusReady?.then === "function") await options.focusReady;
          if (options.focusLabel && typeof focusApp === "function") {
            try { await focusApp(options.focusLabel); } catch { /* best-effort */ }
          }
          if (options.signal?.aborted) {
            return { success: false, error: "You cancelled this command", code: "CANCELLED" };
          }
          if (typeof emitProgress === "function") {
            try { emitProgress("pasting"); } catch { /* ignore */ }
          }
          await pasteText(text, { restoreClipboard: true, silentAccessibilityCheck: true });
          return {
            success: true,
            message: "Wrote into the focused field",
            action,
            args,
            text,
          };
        }
        case "compose_email": {
          if (typeof composeText !== "function") {
            return { success: false, error: "Writing is not available", code: "FAILED" };
          }
          if (options.signal?.aborted) {
            return { success: false, error: "You cancelled this command", code: "CANCELLED" };
          }
          const emitProgress = typeof options.onProgress === "function" ? options.onProgress : onProgress;
          if (typeof emitProgress === "function") {
            try { emitProgress("writing"); } catch { /* ignore */ }
          }
          let generated = "";
          try {
            const write = typeof options.composeText === "function" ? options.composeText : composeText;
            generated = await write(args.prompt, {
              signal: options.signal,
              onToken: options.onToken,
            });
          } catch (error) {
            if (error?.code === "TIMEOUT" || error?.name === "AbortError" || options.signal?.aborted) {
              return {
                success: false,
                error: options.signal?.aborted
                  ? "You cancelled this command"
                  : "Couldn't write that in time",
                code: options.signal?.aborted ? "CANCELLED" : "TIMEOUT",
              };
            }
            return { success: false, error: "Couldn't write that email", code: "COMPOSE_FAILED" };
          }
          const body = clampString(String(generated || "").trim(), MAX_COMPOSE_OUTPUT_LENGTH);
          if (!body) {
            return { success: false, error: "Couldn't write that email", code: "COMPOSE_FAILED" };
          }
          if (options.signal?.aborted) {
            return { success: false, error: "You cancelled this command", code: "CANCELLED" };
          }
          const url = buildGmailComposeUrl({
            to: args.to || "",
            subject: args.subject || "",
            body,
          });
          return perform({ action: "open_url", args: { url, browser: args.browser } }, { ...options, confirmed: true });
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
        case "app_action": {
          const skill = typeof getAppSkill === "function" ? getAppSkill(args.appId) : skillForAction;
          if (!skill || skill.enabled === false) {
            return { success: false, error: `No skill is enabled for "${args.appId}"`, code: "NOT_FOUND" };
          }
          const item = (skill.actions || []).find((row) => row.id === args.actionId);
          if (!item || item.enabled === false) {
            return { success: false, error: `Unknown action "${args.actionId}"`, code: "NOT_FOUND" };
          }
          const filled = fillActionTemplate(item, args.params || {}, { target: skill.target, utterance: request.utterance || args.utterance || options.utterance });
          if (!filled.ok) return { success: false, error: filled.error, code: "NOT_ALLOWED" };
          if (filled.type === "url" || filled.type === "uri") {
            await openExternal(filled.value);
            return { success: true, message: `Opened ${filled.value}`, action, args };
          }
          if (filled.type === "cli") {
            await launchDetached(filled.exe, filled.args);
            return { success: true, message: `Opened ${filled.exe}`, action, args };
          }
          if (filled.type === "keys") {
            if (typeof sendKeys !== "function") {
              return { success: false, error: "Keyboard actions are not available", code: "FAILED" };
            }
            await sendKeys(filled.value);
            return { success: true, message: `Sent ${filled.value}`, action, args };
          }
          if (filled.type === "find_path" || filled.type === "open_path") {
            return perform({ action: filled.type, args: filled.args || {}, utterance: request.utterance }, options);
          }
          return { success: false, error: "Not allowed", code: "NOT_ALLOWED" };
        }
        case "find_path": {
          const finder = typeof options.findPaths === "function" ? options.findPaths : findPaths;
          const found = await finder(args.name, {
            kind: args.kind || "any",
            within: args.within,
            fsImpl,
            env,
            platform,
            timeoutMs: options.findTimeoutMs,
            roots: options.findRoots,
            drives: options.findDrives,
            searchIndex: options.searchIndex || (typeof deps.searchIndex === "function" ? deps.searchIndex : undefined),
          });
          const message = formatFindOutcome(found);
          return {
            success: true,
            message,
            action,
            args,
            matches: found.matches || [],
            query: found.query || args.name,
            kind: found.kind || args.kind,
            missingWithin: found.missingWithin,
          };
        }
        case "open_path": {
          if (args.searchMs) {
            if (platform !== "win32") {
              return { success: false, error: "Explorer search is only available on Windows", code: "UNSUPPORTED" };
            }
            const target = explorerSearchMsUrl(args.searchQuery, args.location || args.path);
            await launchExplorer([target]);
            return { success: true, message: `Searched in File Explorer for ${args.searchQuery}`, action, args, opened: target };
          }
          const filePath = args.path;
          if (args.run && isExecutablePath(filePath)) {
            const alreadyConfirmed = options.confirmed === true;
            if (!alreadyConfirmed) {
              const allowed = typeof confirm === "function" ? await confirm(`Run ${filePath}?`) : false;
              if (!allowed) return { success: false, error: "You cancelled this command", code: "CANCELLED" };
            }
            await launchDetached(filePath, []);
            return { success: true, message: `Ran ${filePath}`, action, args, opened: filePath };
          }
          if (platform === "win32") {
            const isDir = typeof fsImpl?.statSync === "function"
              ? (() => { try { return fsImpl.statSync(filePath).isDirectory(); } catch { return !isExecutablePath(filePath); } })()
              : !isExecutablePath(filePath);
            if (isDir) await launchExplorer([filePath]);
            else await launchExplorer(["/select," + filePath]);
            return { success: true, message: `Opened ${filePath} in File Explorer`, action, args, opened: filePath };
          }
          if (typeof openPath === "function") {
            const error = await openPath(filePath);
            if (error) throw new Error(error);
            return { success: true, message: `Opened ${filePath}`, action, args, opened: filePath };
          }
          return { success: false, error: "Opening paths is not available", code: "UNSUPPORTED" };
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
  MAX_COMPOSE_OUTPUT_LENGTH,
  PLAN_STEP_DELAY_MS,
  needsConfirmation,
  isBlockedCommand,
  isExplorerExecutable,
  isSpawnFailure,
  validateCommandRequest,
  confirmMessage,
  createCommandDispatcher,
  BUILTIN_APPS,
};

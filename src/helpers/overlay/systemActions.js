// Overlay: the ONLY laptop actions the assistant may perform.
//
// Safety rules (enforced here, in the main process, so a model can't get
// around them):
//   - Strict allowlist of action names. Anything else is rejected.
//   - No free-form shell commands. Every script below is fixed; the only
//     inputs are numbers we clamp ourselves, or an app picked from a list.
//   - Risky actions (lock screen, screenshot, brightness) show an on-screen
//     confirmation dialog first.
//   - Shutdown, restart, sleep, sign-out, deleting files: not implemented on
//     purpose.

const path = require("path");
const fs = require("fs");
const appLauncher = require("./appLauncher");
const riskPolicy = require("./commandMode/riskPolicy");

const VK = {
  VOLUME_MUTE: 0xad,
  VOLUME_DOWN: 0xae,
  VOLUME_UP: 0xaf,
  MEDIA_NEXT: 0xb0,
  MEDIA_PREV: 0xb1,
  MEDIA_PLAY_PAUSE: 0xb3,
};

const ACTIONS = {
  volume_up: { confirm: false, description: "Turn the volume up a little" },
  volume_down: { confirm: false, description: "Turn the volume down a little" },
  volume_mute: { confirm: false, description: "Mute or unmute the sound" },
  volume_set: { confirm: false, description: "Set the volume to a level from 0 to 100" },
  media_play_pause: { confirm: false, description: "Play or pause media" },
  media_next: { confirm: false, description: "Next track" },
  media_previous: { confirm: false, description: "Previous track" },
  open_app: { confirm: false, description: "Open an installed app by name" },
  open_url: { confirm: false, description: "Open a http(s) link in the default browser" },
  show_time: { confirm: false, description: "Tell the current date and time" },
  lock_screen: { confirm: true, description: "Lock the screen" },
  screenshot: { confirm: false, description: "Save a screenshot to Pictures\\Overlay Screenshots" },
  brightness_set: { confirm: false, description: "Set screen brightness from 0 to 100" },
};

// Never opened, even if the model asks: shells and system tools.
const BLOCKED_APP_WORDS = [
  "powershell",
  "command prompt",
  "cmd",
  "terminal",
  "bash",
  "wsl",
  "regedit",
  "registry",
  "uninstall",
  "group policy",
  "gpedit",
  "diskpart",
  "format",
];

const BUILTIN_APPS = {
  notepad: { type: "exe", target: "notepad.exe", label: "Notepad" },
  calculator: { type: "exe", target: "calc.exe", label: "Calculator" },
  calc: { type: "exe", target: "calc.exe", label: "Calculator" },
  explorer: { type: "exe", target: "explorer.exe", label: "File Explorer" },
  "file explorer": { type: "exe", target: "explorer.exe", label: "File Explorer" },
  files: { type: "exe", target: "explorer.exe", label: "File Explorer" },
  paint: { type: "exe", target: "mspaint.exe", label: "Paint" },
  "task manager": { type: "exe", target: "taskmgr.exe", label: "Task Manager" },
  settings: { type: "uri", target: "ms-settings:", label: "Settings" },
  "snipping tool": { type: "uri", target: "ms-screenclip:", label: "Snipping Tool" },
};

// Spoken or typed aliases (including common typos) to a canonical search name.
const APP_ALIASES = {
  nordpad: "notepad",
  "note pad": "notepad",
  calc: "calculator",
  "file explorer": "explorer",
  files: "explorer",
  chrome: "google chrome",
  "google chrome": "google chrome",
  edge: "microsoft edge",
  "ms edge": "microsoft edge",
  "microsoft edge": "microsoft edge",
  "vs code": "visual studio code",
  vscode: "visual studio code",
  code: "visual studio code",
  "visual studio code": "visual studio code",
  settings: "settings",
  word: "word",
  "ms word": "word",
  "microsoft word": "word",
  excel: "excel",
  "ms excel": "excel",
  "microsoft excel": "excel",
  spotify: "spotify",
  whatsapp: "whatsapp",
};

function canonicalAppName(value) {
  const name = normalizeName(value);
  if (!name) return name;
  if (APP_ALIASES[name]) return APP_ALIASES[name];
  const collapsed = name.replace(/\s+/g, "");
  if (APP_ALIASES[collapsed]) return APP_ALIASES[collapsed];
  return name;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(exe|lnk)$/i, "")
    .replace(/[^a-z0-9+ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlockedApp(name) {
  const n = ` ${normalizeName(name)} `;
  return BLOCKED_APP_WORDS.some((word) => n.includes(` ${word} `));
}

function clampLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Checks a request against the allowlist. Never runs anything. */
function validateRequest(request) {
  if (!request || typeof request !== "object") return { ok: false, error: "Invalid request" };
  const action = typeof request.action === "string" ? request.action.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return {
      ok: false,
      error: `Action "${action || "(none)"}" is not allowed. Allowed: ${Object.keys(ACTIONS).join(", ")}`,
    };
  }
  const params = {};
  if (action === "volume_set" || action === "brightness_set") {
    const level = clampLevel(request.level);
    if (level === null) return { ok: false, error: `${action} needs a level from 0 to 100` };
    params.level = level;
  }
  if (action === "open_app") {
    const app = normalizeName(request.app);
    if (!app || app.length > 60) return { ok: false, error: "open_app needs an app name" };
    if (isBlockedApp(app)) return { ok: false, error: `Opening "${app}" is not allowed` };
    params.app = app;
  }
  if (action === "open_url") {
    let url;
    try {
      url = new URL(String(request.url || "").trim());
    } catch {
      return { ok: false, error: "open_url needs a full http(s) link" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "Only http and https links can be opened" };
    }
    params.url = url.toString();
  }
  return { ok: true, action, params, confirm: ACTIONS[action].confirm };
}

function startMenuDirs(env = process.env) {
  return [
    env.ProgramData && path.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"),
    env.APPDATA && path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
  ].filter(Boolean);
}

function listShortcuts(dirs, fsImpl = fs, maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) walk(full, depth + 1);
      else if (entry.isFile() && /\.lnk$/i.test(entry.name)) {
        found.push({ name: normalizeName(entry.name), path: full });
      }
    }
  };
  for (const dir of dirs) walk(dir, 0);
  return found;
}

/** Finds an app: built-in list first, then Start-menu shortcuts and app launcher index. */
function resolveApp(appName, options = {}) {
  return appLauncher.resolveApp(appName, options);
}

function keyPressScript(vk, times) {
  const code = Number(vk) & 0xff;
  const count = Math.min(Math.max(Number(times) | 0, 1), 60);
  return [
    "$sig='[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'",
    "Add-Type -MemberDefinition $sig -Name OverlayKeys -Namespace OverlayNative",
    `for($i=0;$i -lt ${count};$i++){[OverlayNative.OverlayKeys]::keybd_event(${code},0,0,[UIntPtr]::Zero);[OverlayNative.OverlayKeys]::keybd_event(${code},0,2,[UIntPtr]::Zero);Start-Sleep -Milliseconds 15}`,
  ].join("; ");
}

function screenshotScript(filePath) {
  const safe = filePath.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height",
    "$g=[System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)",
    `$bmp.Save('${safe}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose(); $bmp.Dispose()",
  ].join("; ");
}

function brightnessScript(level) {
  const n = clampLevel(level) ?? 50;
  return `(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1 | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=1;Brightness=[byte]${n}}) | Out-Null`;
}

/**
 * Creates the executor. Everything that touches the OS is injected so the
 * allowlist can be tested without Electron or Windows.
 */
function createSystemActions(deps) {
  const {
    platform = process.platform,
    env = process.env,
    execFile, // (file, args, options) => Promise
    openPath, // shell.openPath
    openExternal, // shell.openExternal
    confirm, // (message) => Promise<boolean>
    picturesDir,
    now = () => new Date(),
    fsImpl = fs,
    findNircmd = () => null,
  } = deps;

  const runPowerShell = (script) =>
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true, timeout: 15000 }
    );

  const pressKey = (vk, times = 1) => runPowerShell(keyPressScript(vk, times));

  async function setVolume(level) {
    const nircmd = findNircmd();
    if (nircmd) {
      await execFile(nircmd, ["setsysvolume", String(Math.round((level / 100) * 65535))], {
        windowsHide: true,
        timeout: 5000,
      });
      return;
    }
    // Without nircmd: go to 0, then step up (each key press is 2%).
    await pressKey(VK.VOLUME_DOWN, 50);
    if (level > 0) await pressKey(VK.VOLUME_UP, Math.round(level / 2));
  }

  async function perform(request) {
    const check = validateRequest(request);
    if (!check.ok) return { success: false, error: check.error, code: "NOT_ALLOWED" };
    const { action, params } = check;

    if (action === "show_time") {
      const d = now();
      return {
        success: true,
        message: `It is ${d.toLocaleTimeString()} on ${d.toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })}.`,
      };
    }

    if (platform !== "win32" && action !== "open_url") {
      return {
        success: false,
        error: "This action is only available on Windows",
        code: "UNSUPPORTED",
      };
    }

    const riskTier = riskPolicy.classify({ action, params });
    if (riskTier === "block") {
      return { success: false, error: "Action is blocked for security", code: "BLOCKED" };
    }
    if (riskTier === "confirm") {
      const detail =
        action === "brightness_set"
          ? `Set screen brightness to ${params.level}%?`
          : `${ACTIONS[action].description}?`;
      const allowed = await confirm(detail, { step: { action, params } });
      if (!allowed)
        return { success: false, error: "You cancelled this action", code: "CANCELLED" };
    }

    try {
      switch (action) {
        case "volume_up":
          await pressKey(VK.VOLUME_UP, 5);
          return { success: true, message: "Volume up" };
        case "volume_down":
          await pressKey(VK.VOLUME_DOWN, 5);
          return { success: true, message: "Volume down" };
        case "volume_mute":
          await pressKey(VK.VOLUME_MUTE, 1);
          return { success: true, message: "Toggled mute" };
        case "volume_set":
          await setVolume(params.level);
          return { success: true, message: `Volume set to about ${params.level}%` };
        case "media_play_pause":
          await pressKey(VK.MEDIA_PLAY_PAUSE, 1);
          return { success: true, message: "Play/pause" };
        case "media_next":
          await pressKey(VK.MEDIA_NEXT, 1);
          return { success: true, message: "Next track" };
        case "media_previous":
          await pressKey(VK.MEDIA_PREV, 1);
          return { success: true, message: "Previous track" };
        case "open_url":
          await openExternal(params.url);
          return { success: true, message: `Opened ${params.url}` };
        case "open_app": {
          const app = resolveApp(params.app, {
            shortcuts: listShortcuts(startMenuDirs(env), fsImpl),
          });
          if (!app) {
            return {
              success: false,
              error: `Couldn't find an app called "${params.app}"`,
              code: "NOT_FOUND",
            };
          }
          await appLauncher.launchApp(app, { execFile, openPath, openExternal });
          return { success: true, message: `Opened ${app.name || app.label}` };
        }
        case "lock_screen":
          await execFile("rundll32.exe", ["user32.dll,LockWorkStation"], {
            windowsHide: true,
            timeout: 5000,
          });
          return { success: true, message: "Screen locked" };
        case "screenshot": {
          const dir = path.join(picturesDir, "Overlay Screenshots");
          fsImpl.mkdirSync(dir, { recursive: true });
          const stamp = now().toISOString().replace(/[:.]/g, "-");
          const file = path.join(dir, `overlay-${stamp}.png`);
          await runPowerShell(screenshotScript(file));
          return { success: true, message: `Screenshot saved to ${file}` };
        }
        case "brightness_set":
          await runPowerShell(brightnessScript(params.level));
          return { success: true, message: `Brightness set to ${params.level}%` };
        default:
          return { success: false, error: "Not allowed", code: "NOT_ALLOWED" };
      }
    } catch (error) {
      return { success: false, error: `Action failed: ${error.message}`, code: "FAILED" };
    }
  }

  return { perform };
}

module.exports = {
  ACTIONS,
  BUILTIN_APPS,
  BLOCKED_APP_WORDS,
  VK,
  validateRequest,
  resolveApp,
  launchApp: appLauncher.launchApp,
  canonicalAppName,
  APP_ALIASES,
  listShortcuts,
  startMenuDirs,
  keyPressScript,
  normalizeName,
  isBlockedApp,
  createSystemActions,
};

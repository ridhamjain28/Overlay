// Windows app inventory scanner. All I/O is injectable so tests can mock
// the registry, Start Menu, shortcuts, and Get-StartApps.

const fs = require("fs");
const path = require("path");
const { startMenuDirs, listShortcuts, normalizeName } = require("./systemActions");

function slugify(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "app";
}

function exeNameOf(target) {
  if (!target) return "";
  const normalized = String(target).replace(/\\/g, "/");
  return path.posix.basename(normalized).toLowerCase();
}

function uniquePush(list, seen, item, key) {
  if (!item || !key || seen.has(key)) return;
  seen.add(key);
  list.push(item);
}

async function defaultExecJson(execFile, script, timeout = 20000) {
  if (typeof execFile !== "function") return [];
  try {
    const result = await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout, encoding: "utf8" }
    );
    const stdout = result && result.stdout != null ? String(result.stdout) : String(result || "");
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

function defaultListAppPathsScript() {
  return [
    "$paths=@()",
    "foreach($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')){",
    "  if(-not (Test-Path $root)){continue}",
    "  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {",
    "    $exe=$_.PSChildName; $val=$null; try{$val=(Get-ItemProperty $_.PsPath -ErrorAction Stop).'(default)'}catch{}",
    "    if($exe){$paths+=[pscustomobject]@{exe=$exe;path=[string]$val}}",
    "  }",
    "}",
    "$paths | ConvertTo-Json -Compress",
  ].join("; ");
}

function defaultStartAppsScript() {
  return "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress";
}

function defaultProtocolsScript() {
  return [
    "$out=@()",
    "Get-ChildItem Registry::HKEY_CLASSES_ROOT -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try {",
    "    $p=Get-ItemProperty $_.PsPath -ErrorAction Stop",
    "    if($null -ne $p.'URL Protocol'){",
    "      $cmd=$null",
    "      try{$cmd=(Get-ItemProperty ($_.PsPath+'\\shell\\open\\command') -ErrorAction Stop).'(default)'}catch{}",
    "      if($cmd){$out+=[pscustomobject]@{protocol=$_.PSChildName;command=[string]$cmd}}",
    "    }",
    "  } catch {}",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join("; ");
}

function appFromShortcut(shortcut, link) {
  const name = shortcut.name || normalizeName(path.basename(shortcut.path || "", ".lnk"));
  const target = link && (link.target || link.path) || shortcut.path;
  return {
    id: slugify(name),
    name: link?.description || name,
    type: "exe",
    target,
    exeName: exeNameOf(target),
    source: "start_menu",
    shortcutPath: shortcut.path,
  };
}

function appFromAppPath(entry) {
  const exe = String(entry.exe || entry.Name || "");
  const target = String(entry.path || entry.Path || "");
  const name = exe.replace(/\.exe$/i, "");
  return {
    id: slugify(name),
    name,
    type: "exe",
    target,
    exeName: exeNameOf(exe || target),
    source: "app_paths",
  };
}

function appFromStartApp(entry) {
  const name = String(entry.Name || entry.name || "");
  const aumid = String(entry.AppID || entry.AppId || entry.aumid || "");
  return {
    id: slugify(name || aumid),
    name: name || aumid,
    type: "uwp",
    aumid,
    target: aumid ? `shell:AppsFolder\\${aumid}` : "",
    source: "start_apps",
  };
}

function appFromProtocol(entry) {
  const protocol = String(entry.protocol || entry.Protocol || "").replace(/:$/, "");
  if (!protocol) return null;
  return {
    id: slugify(protocol),
    name: protocol,
    type: "protocol",
    protocols: [`${protocol}:`],
    target: `${protocol}:`,
    source: "protocol",
  };
}

async function scanInstalledApps(opts = {}) {
  const env = opts.env || process.env;
  const fsImpl = opts.fsImpl || fs;
  const report = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const apps = [];
  const seen = new Set();

  report({ stage: "start-menu", current: 0, total: 4, message: "Reading Start Menu shortcuts" });
  const shortcuts = opts.shortcuts || listShortcuts(startMenuDirs(env), fsImpl);
  const readLink = opts.readShortcutLink;
  for (const shortcut of shortcuts) {
    let link = null;
    if (typeof readLink === "function") {
      try {
        link = readLink(shortcut.path);
      } catch {
        link = null;
      }
    }
    const app = appFromShortcut(shortcut, link);
    uniquePush(apps, seen, app, `exe:${app.exeName || app.target || app.id}`);
  }

  report({ stage: "app-paths", current: 1, total: 4, message: "Reading App Paths" });
  const appPaths =
    opts.appPaths ||
    (await defaultExecJson(opts.execFile, opts.appPathsScript || defaultListAppPathsScript()));
  for (const entry of appPaths) {
    const app = appFromAppPath(entry);
    uniquePush(apps, seen, app, `exe:${app.exeName || app.id}`);
  }

  report({ stage: "start-apps", current: 2, total: 4, message: "Reading installed apps" });
  const startApps =
    opts.startApps ||
    (await defaultExecJson(opts.execFile, opts.startAppsScript || defaultStartAppsScript()));
  for (const entry of startApps) {
    const app = appFromStartApp(entry);
    const key = app.aumid ? `aumid:${app.aumid.toLowerCase()}` : `name:${app.id}`;
    uniquePush(apps, seen, app, key);
  }

  report({ stage: "protocols", current: 3, total: 4, message: "Reading URL protocols" });
  const protocols =
    opts.protocols ||
    (await defaultExecJson(opts.execFile, opts.protocolsScript || defaultProtocolsScript()));
  for (const entry of protocols) {
    const app = appFromProtocol(entry);
    if (app) uniquePush(apps, seen, app, `proto:${app.protocols[0]}`);
  }

  report({ stage: "done", current: 4, total: 4, message: "Scan complete" });
  return { scannedAt: new Date(opts.now || Date.now()).toISOString(), apps };
}

module.exports = {
  scanInstalledApps,
  slugify,
  exeNameOf,
  appFromShortcut,
  appFromAppPath,
  appFromStartApp,
  appFromProtocol,
  defaultListAppPathsScript,
  defaultStartAppsScript,
  defaultProtocolsScript,
};

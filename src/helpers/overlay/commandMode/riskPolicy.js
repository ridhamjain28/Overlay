// Central risk policy module for Overlay Command mode, System Actions, and MCP tools.
// Categorizes every action into:
//   - "auto": runs immediately without dialog (ONLY built-in Overlay actions!)
//   - "confirm": shows native confirmation dialog ("Overlay wants to do this on your laptop")
//   - "block": refused even after confirm (destructive / malicious / credential export)
// Rule: first use of any MCP tool asks; user can then "Always allow" it.
// Hints like readOnlyHint are untrusted server metadata and NEVER bypass confirmation.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PERMISSIONS_FILE = "risk-permissions.json";

// High-risk patterns that must always be BLOCKED
const BLOCK_PATTERNS = [
  // Disable security / Defender / firewall
  /set-mppreference.*-disablerealtime.*true/i,
  /disable-realtime-monitoring/i,
  /stop-service\s+(windefend|mpssvc)/i,
  /sc\s+stop\s+(windefend|mpssvc)/i,
  /netsh\s+advfirewall\s+set.*(off|disabled)/i,
  // Format disks
  /\bformat\s+[a-z]:/i,
  /\b(diskpart|cipher\s+\/w|mkfs|dd\s+if=)/i,
  // Credential / token export
  /\b(mimikatz|vaultcli)\b/i,
  /reg\s+save\s+hklm\\(sam|system)/i,
  /rundll32.*comsvcs.*minidump/i,
  /procdump.*lsass/i,
  /export-pfxcertificate/i,
];

// Confirm patterns for shell commands
const CONFIRM_COMMAND_PATTERNS = [
  /\b(shutdown|restart-computer|stop-computer|shutdown\.exe)\b/i,
  /\b(rmdir\s+\/s|rd\s+\/s|del\s+\/s|erase\s+\/s|remove-item\b.*(-recurse|-r\b))\b/i,
  /\b(rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|--recursive))\b/i,
  /\b(taskkill|stop-process)\b/i,
  /\b(reg\s+(delete|add|import)|regedit|regedt32)\b/i,
  /\b(sc\s+(delete|create|config)|stop-service)\b/i,
  /\b(net\s+user|net\s+localgroup|net\s+share)\b/i,
  /\b(invoke-expression|\biex\b|invoke-webrequest\b.*\|\s*iex)\b/i,
];

function computeToolSchemaHash(toolOrStep) {
  if (!toolOrStep || typeof toolOrStep !== "object") return "";
  const desc = String(toolOrStep.description || "").trim();
  const schema = JSON.stringify(toolOrStep.inputSchema || toolOrStep.schema || {});
  return crypto.createHash("sha256").update(`${desc}:${schema}`).digest("hex").slice(0, 32);
}

function stepKey(step) {
  if (!step || typeof step !== "object") return "unknown";
  const action = String(step.action || step.type || "").trim();
  if (action === "mcp" || step.type === "mcp") {
    const server = String(step.server || "").trim();
    const tool = String(step.tool || "").trim();
    return `mcp:${server}:${tool}`;
  }
  if (action === "app_action") {
    const appId = String(step.args?.appId || "").trim();
    const actionId = String(step.args?.actionId || "").trim();
    return `app_action:${appId}:${actionId}`;
  }
  if (action === "run_command") {
    const cmd = String(step.args?.command || step.command || "").trim();
    return `run_command:${cmd}`;
  }
  if (action.startsWith("system:") || action.includes("_")) {
    return `system:${action}`;
  }
  return action;
}

function loadPermissions(userDataDir, fsImpl = fs) {
  if (!userDataDir) return new Map();
  const filePath = path.join(userDataDir, PERMISSIONS_FILE);
  try {
    if (!fsImpl.existsSync(filePath)) return new Map();
    const raw = fsImpl.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    const map = new Map();
    if (data && typeof data.permissions === "object" && !Array.isArray(data.permissions)) {
      for (const [k, v] of Object.entries(data.permissions)) {
        if (v && typeof v === "object") map.set(k, v);
      }
    } else if (Array.isArray(data?.allowedKeys)) {
      for (const k of data.allowedKeys) {
        if (k) map.set(String(k).trim(), { key: String(k).trim(), type: "legacy" });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function savePermissions(userDataDir, permissions, fsImpl = fs) {
  if (!userDataDir) return;
  const filePath = path.join(userDataDir, PERMISSIONS_FILE);
  try {
    const obj = {};
    if (permissions instanceof Map) {
      for (const [k, v] of permissions.entries()) {
        obj[k] = v;
      }
    } else if (permissions instanceof Set) {
      for (const k of permissions) {
        obj[k] = { key: k, type: "legacy" };
      }
    } else if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) {
      Object.assign(obj, permissions);
    }
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(
      filePath,
      JSON.stringify(
        {
          allowedKeys: Object.keys(obj),
          permissions: obj,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    // Ignore write failures in read-only / restricted environments
  }
}

function isAlwaysAllowed(step, permissions, options = {}) {
  if (!permissions) return false;
  const key = stepKey(step);
  let entry = null;
  if (permissions instanceof Map) {
    entry = permissions.get(key);
  } else if (permissions instanceof Set) {
    if (permissions.has(key)) entry = { key, type: "legacy" };
  } else if (Array.isArray(permissions)) {
    if (permissions.includes(key)) entry = { key, type: "legacy" };
  } else if (typeof permissions === "object") {
    entry = permissions[key];
  }
  if (!entry) return false;

  // For MCP tools: invalidate permission if inputSchema or description hash changed!
  const isMcp = step.type === "mcp" || step.action === "mcp";
  if (isMcp && entry.schemaHash) {
    const currentHash = computeToolSchemaHash(step);
    if (currentHash && entry.schemaHash !== currentHash) {
      if (options.userDataDir) {
        revokePermission(options.userDataDir, key, options.fsImpl || fs);
      }
      return false;
    }
  }
  return true;
}

function allowAction(userDataDir, step, fsImpl = fs) {
  if (isBlocked(step)) return false; // NEVER offer or allow for "block"
  const permissions = loadPermissions(userDataDir, fsImpl);
  const key = stepKey(step);
  const isMcp = step.type === "mcp" || step.action === "mcp";
  const entry = {
    key,
    type: isMcp ? "mcp" : "builtin",
    allowedAt: Date.now(),
  };
  if (isMcp) {
    entry.server = String(step.server || "").trim();
    entry.tool = String(step.tool || "").trim();
    entry.schemaHash = computeToolSchemaHash(step);
  } else {
    entry.action = key;
  }
  permissions.set(key, entry);
  savePermissions(userDataDir, permissions, fsImpl);
  return true;
}

function revokePermission(userDataDir, key, fsImpl = fs) {
  const permissions = loadPermissions(userDataDir, fsImpl);
  if (permissions.delete(key)) {
    savePermissions(userDataDir, permissions, fsImpl);
    return true;
  }
  return false;
}

function revokeServerPermissions(userDataDir, serverName, fsImpl = fs) {
  const permissions = loadPermissions(userDataDir, fsImpl);
  let changed = false;
  const prefix = `mcp:${serverName}:`;
  for (const key of Array.from(permissions.keys())) {
    if (key.startsWith(prefix)) {
      permissions.delete(key);
      changed = true;
    }
  }
  if (changed) {
    savePermissions(userDataDir, permissions, fsImpl);
  }
  return changed;
}

function listSavedPermissions(userDataDir, fsImpl = fs) {
  const permissions = loadPermissions(userDataDir, fsImpl);
  const list = [];
  for (const [key, val] of permissions.entries()) {
    list.push({
      key,
      type: val.type || (key.startsWith("mcp:") ? "mcp" : "builtin"),
      server: val.server || (key.startsWith("mcp:") ? key.split(":")[1] : undefined),
      tool: val.tool || (key.startsWith("mcp:") ? key.split(":")[2] : undefined),
      action: val.action || key,
      allowedAt: val.allowedAt || 0,
    });
  }
  return list;
}

function isBlocked(step) {
  if (!step || typeof step !== "object") return false;
  const action = String(step.action || step.type || "").trim().toLowerCase();
  if (action === "block") return true;

  // Check command string
  const command = String(step.args?.command || step.command || step.args?.value || "").trim();
  if (command && BLOCK_PATTERNS.some((pattern) => pattern.test(command))) {
    return true;
  }

  // Check text or url for malicious patterns
  const url = String(step.args?.url || step.url || "").trim();
  if (url && BLOCK_PATTERNS.some((pattern) => pattern.test(url))) {
    return true;
  }

  // Check MCP tool name or args for block patterns
  if (step.type === "mcp" || action === "mcp") {
    const tool = String(step.tool || "").toLowerCase();
    if (/format.*disk|disable.*defender|export.*token|dump.*lsass/i.test(tool)) {
      return true;
    }
  }

  return false;
}

function classify(step, options = {}) {
  if (!step || typeof step !== "object") return "auto";

  // 1. Check BLOCK tier - NEVER bypassed
  if (isBlocked(step)) {
    return "block";
  }

  // 2. Check "Ask before every action" toggle: if true, TRULY overrides auto for everything
  if (options.askBeforeEveryAction === true) {
    return "confirm";
  }

  // 3. Check permissions / always allow
  const permissions =
    options.permissions || (options.userDataDir ? loadPermissions(options.userDataDir, options.fsImpl) : null);
  if (isAlwaysAllowed(step, permissions, { userDataDir: options.userDataDir, fsImpl: options.fsImpl })) {
    return "auto";
  }

  const action = String(step.action || step.type || "").trim().toLowerCase();
  const args = step.args || step.params || {};

  // 4. Database actions with explicit risk
  if (step.risk === "confirm") return "confirm";
  if (step.risk === "safe") return "auto";

  // 5. MCP tools:
  // Rule: first use of ANY MCP tool asks; user can then "Always allow" it.
  // Hints like readOnlyHint are untrusted server metadata and NEVER bypass confirmation.
  // Only built-in Overlay actions use the auto tier.
  if (step.type === "mcp" || action === "mcp") {
    return "confirm";
  }

  // 6. CONFIRM tier actions (built-in destructive or stateful actions)
  // - Send message / email (real send, not prefill)
  if (
    action === "send_message" ||
    action === "send_email" ||
    action === "send_chat" ||
    (action === "app_action" && /send_message|send_email|send_mail|send/i.test(String(args.actionId || "")))
  ) {
    return "confirm";
  }

  // - Delete / move / overwrite files
  if (
    action === "delete_file" ||
    action === "remove_file" ||
    action === "move_file" ||
    action === "overwrite_file" ||
    (action === "app_action" && /delete|remove|destroy|wipe/i.test(String(args.actionId || "")))
  ) {
    return "confirm";
  }

  // - Uninstall
  if (action === "uninstall" || action === "uninstall_app" || /uninstall/i.test(String(args.actionId || ""))) {
    return "confirm";
  }

  // - Kill processes
  if (action === "kill_process" || action === "kill" || /kill|terminate/i.test(String(args.actionId || ""))) {
    return "confirm";
  }

  // - Shutdown / restart / sign out / sleep / lock screen
  if (
    action === "shutdown" ||
    action === "restart" ||
    action === "sleep" ||
    action === "sign_out" ||
    action === "lock_screen" ||
    /shutdown|restart|reboot|sleep|lock/i.test(String(args.actionId || ""))
  ) {
    return "confirm";
  }

  // - Purchases
  if (
    action === "purchase" ||
    action === "buy" ||
    action === "pay" ||
    /purchase|buy|checkout|pay/i.test(String(args.actionId || ""))
  ) {
    return "confirm";
  }

  // - Running shell/cli commands not in DB or running an executable found via find_path
  if (action === "run_command") {
    return "confirm";
  }

  // Running an executable file via open_path / find_path
  if (
    (action === "open_path" || action === "find_path") &&
    (/\.(exe|bat|cmd|ps1|vbs|msi)$/i.test(String(args.path || step.path || "")) ||
      step.isExecutable === true ||
      args.isExecutable === true)
  ) {
    return "confirm";
  }

  // Check command string against confirm patterns
  const cmd = String(args.command || step.command || "").trim();
  if (cmd && CONFIRM_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd))) {
    return "confirm";
  }

  // 7. AUTO tier actions (Built-in Overlay actions only)
  // - Brightness
  if (action === "brightness_set" || action === "brightness") return "auto";

  // - Volume & Mute
  if (
    action === "volume_up" ||
    action === "volume_down" ||
    action === "volume_mute" ||
    action === "volume_set"
  ) {
    return "auto";
  }

  // - Media play/pause/next/previous
  if (
    action === "media_play_pause" ||
    action === "media_next" ||
    action === "media_previous"
  ) {
    return "auto";
  }

  // - Network / Wi-Fi / Bluetooth / Airplane / Night light / Dark mode
  if (
    action === "wifi_toggle" ||
    action === "bluetooth_toggle" ||
    action === "airplane_toggle" ||
    action === "night_light" ||
    action === "dark_mode" ||
    (action === "open_url" && String(args.url || "").startsWith("ms-settings:"))
  ) {
    return "auto";
  }

  // - Open app / URL / file / folder
  if (
    action === "open_app" ||
    action === "open_url" ||
    action === "open_file" ||
    action === "open_path" ||
    action === "find_path"
  ) {
    return "auto";
  }

  // - Search
  if (action === "search") return "auto";

  // - Window focus / min / max / keys
  if (
    action === "focus_app" ||
    action === "window_focus" ||
    action === "submit_page" ||
    action === "guide"
  ) {
    return "auto";
  }

  // - Screenshots
  if (action === "screenshot") return "auto";

  // - Timers & show time
  if (action === "show_time" || action === "timer") return "auto";

  // - Clipboard read
  if (action === "clipboard_read" || action === "read_clipboard") return "auto";

  // - Prefills the user still sends
  if (
    action === "compose_text" ||
    action === "compose_email" ||
    action === "type_text"
  ) {
    return "auto";
  }

  // - App action default: if launch/open/show, auto
  if (action === "app_action") {
    const actionId = String(args.actionId || "").toLowerCase();
    if (actionId === "launch" || actionId === "open" || actionId === "show") {
      return "auto";
    }
  }

  // Default fallback for safe desktop assistance
  return "auto";
}

function formatPlainLanguageArgs(args) {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args).filter(
    ([k, v]) => v !== undefined && v !== null && v !== "" && k !== "appId" && k !== "actionId"
  );
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      let str = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (str.length > 80) str = str.slice(0, 77) + "...";
      return `${k}: "${str}"`;
    })
    .join(", ");
}

function formatRiskConfirmDetail(step) {
  if (!step) return "Run this action?";
  const action = String(step.action || step.type || "").trim();
  const args = step.args || step.params || {};
  if (action === "mcp" || step.type === "mcp") {
    const argSummary = formatPlainLanguageArgs(args);
    return `Call tool "${step.tool}" on MCP server "${step.server}"${argSummary ? ` with ${argSummary}` : ""}?`;
  }
  if (action === "run_command") {
    return `Run shell command: ${String(args.command || step.command || "").slice(0, 100)}`;
  }
  if (action === "app_action") {
    const argSummary = formatPlainLanguageArgs(args);
    return `Perform action "${args.actionId}" on ${args.appId}${argSummary ? ` (${argSummary})` : ""}?`;
  }
  if (action === "open_path") {
    return `Open "${args.path || step.path}" in File Explorer?`;
  }
  if (action === "find_path") {
    return `Search for "${args.name || step.name}"?`;
  }
  if (action === "shutdown" || action === "lock_screen") {
    return `Perform ${action.replace("_", " ")} on your laptop?`;
  }
  const argSummary = formatPlainLanguageArgs(args);
  return `Run ${action.replace(/_/g, " ")}${argSummary ? ` with ${argSummary}` : ""}?`;
}

module.exports = {
  classify,
  stepKey,
  computeToolSchemaHash,
  isAlwaysAllowed,
  allowAction,
  revokePermission,
  revokeServerPermissions,
  listSavedPermissions,
  loadPermissions,
  savePermissions,
  isBlocked,
  formatRiskConfirmDetail,
  formatPlainLanguageArgs,
  BLOCK_PATTERNS,
  CONFIRM_COMMAND_PATTERNS,
};

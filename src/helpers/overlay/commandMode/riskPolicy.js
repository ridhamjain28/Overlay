// Central risk policy module for Overlay Command mode, System Actions, and MCP tools.
// Categorizes every action into:
//   - "auto": runs immediately without dialog
//   - "confirm": shows native confirmation dialog ("Overlay wants to do this on your laptop")
//   - "block": refused even after confirm (destructive / malicious / credential export)

const fs = require("fs");
const path = require("path");

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
  if (!userDataDir) return new Set();
  const filePath = path.join(userDataDir, PERMISSIONS_FILE);
  try {
    if (!fsImpl.existsSync(filePath)) return new Set();
    const raw = fsImpl.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data?.allowedKeys) ? data.allowedKeys : [];
    return new Set(list.map((k) => String(k).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function savePermissions(userDataDir, permissions, fsImpl = fs) {
  if (!userDataDir) return;
  const filePath = path.join(userDataDir, PERMISSIONS_FILE);
  try {
    const allowedKeys = Array.from(permissions instanceof Set ? permissions : new Set(permissions));
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify({ allowedKeys }, null, 2), "utf-8");
  } catch {
    // Ignore write failures in read-only / restricted environments
  }
}

function isAlwaysAllowed(step, permissions) {
  if (!permissions) return false;
  const key = stepKey(step);
  if (permissions instanceof Set) return permissions.has(key);
  if (Array.isArray(permissions)) return permissions.includes(key);
  return false;
}

function allowAction(userDataDir, step, fsImpl = fs) {
  const current = loadPermissions(userDataDir, fsImpl);
  const key = stepKey(step);
  current.add(key);
  savePermissions(userDataDir, current, fsImpl);
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

  // Check permissions / always allow
  const permissions =
    options.permissions || (options.userDataDir ? loadPermissions(options.userDataDir, options.fsImpl) : null);
  if (isAlwaysAllowed(step, permissions)) {
    return "auto";
  }

  // If "Ask before every action" toggle is enabled, everything non-block asks first
  if (options.askBeforeEveryAction === true) {
    return "confirm";
  }

  const action = String(step.action || step.type || "").trim().toLowerCase();
  const args = step.args || step.params || {};

  // 2. Database actions with explicit risk
  if (step.risk === "confirm") return "confirm";
  if (step.risk === "safe") return "auto";

  // 3. MCP tools
  if (step.type === "mcp" || action === "mcp") {
    const annotations = step.annotations || {};
    if (annotations.readOnlyHint === true || step.readOnlyHint === true) {
      return "auto";
    }
    // Destructive or unknown MCP tools require confirmation
    return "confirm";
  }

  // 4. CONFIRM tier actions
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

  // - Running shell/cli commands not in DB
  if (action === "run_command") {
    return "confirm";
  }

  // Check command string against confirm patterns
  const cmd = String(args.command || step.command || "").trim();
  if (cmd && CONFIRM_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd))) {
    return "confirm";
  }

  // 5. AUTO tier actions
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

  // - Open app / URL / file
  if (action === "open_app" || action === "open_url" || action === "open_file") {
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

  // - App action default: if not explicitly confirm, check if launch/open
  if (action === "app_action") {
    const actionId = String(args.actionId || "").toLowerCase();
    if (actionId === "launch" || actionId === "open" || actionId === "show") {
      return "auto";
    }
  }

  // Default fallback for safe desktop assistance
  return "auto";
}

function formatRiskConfirmDetail(step) {
  if (!step) return "Run this action?";
  const action = String(step.action || step.type || "").trim();
  const args = step.args || step.params || {};
  if (action === "mcp" || step.type === "mcp") {
    return `Call tool "${step.tool}" on MCP server "${step.server}"?`;
  }
  if (action === "run_command") {
    return `Run shell command: ${String(args.command || step.command || "").slice(0, 100)}`;
  }
  if (action === "app_action") {
    return `Perform action "${args.actionId}" on ${args.appId}?`;
  }
  if (action === "shutdown" || action === "lock_screen") {
    return `Perform ${action.replace("_", " ")} on your laptop?`;
  }
  return `Run ${action}?`;
}

module.exports = {
  classify,
  stepKey,
  isAlwaysAllowed,
  allowAction,
  loadPermissions,
  savePermissions,
  isBlocked,
  formatRiskConfirmDetail,
  BLOCK_PATTERNS,
  CONFIRM_COMMAND_PATTERNS,
};

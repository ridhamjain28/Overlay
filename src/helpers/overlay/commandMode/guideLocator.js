// Overlay Command mode: best-effort "point at the button" on Windows.
// Enumerates named UI controls in the foreground window via UI Automation.
// Injected execFile keeps this testable without a display.

const UIA_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OverlayFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
$hwnd = [OverlayFg]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output '{"error":"no_foreground"}'; exit 0 }
[uint32]$pid = 0
[void][OverlayFg]::GetWindowThreadProcessId($hwnd, [ref]$pid)
$sb = New-Object System.Text.StringBuilder 512
[void][OverlayFg]::GetWindowText($hwnd, $sb, $sb.Capacity)
$title = $sb.ToString()
$procName = ''
try { $procName = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName } catch {}
$el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if (-not $el) { Write-Output ('{"error":"no_element","title":' + ($title | ConvertTo-Json -Compress) + ',"pid":' + $pid + ',"processName":' + ($procName | ConvertTo-Json -Compress) + '}'); exit 0 }
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
$all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$wanted = @('Button','MenuItem','Hyperlink','TabItem','SplitButton','CheckBox','RadioButton','ComboBox','Edit','ListItem','TreeItem','DataItem','HeaderItem','Thumb')
$controls = New-Object System.Collections.Generic.List[object]
$max = 120
foreach ($c in $all) {
  if ($controls.Count -ge $max) { break }
  try {
    $ct = $c.Current.ControlType.ProgrammaticName
    $name = $c.Current.Name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $short = $ct -replace '^ControlType\\.?',''
    if ($wanted -notcontains $short) { continue }
    $r = $c.Current.BoundingRectangle
    if ($r.Width -lt 2 -or $r.Height -lt 2) { continue }
    $controls.Add([pscustomobject]@{
      name = $name.Trim()
      type = $short
      x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
    })
  } catch {}
}
$result = [pscustomobject]@{
  title = $title
  pid = $pid
  processName = $procName
  controls = $controls
}
$result | ConvertTo-Json -Compress -Depth 5
`;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[&._-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreControl(query, control) {
  const q = normalize(query);
  const n = normalize(control.name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q) || q.startsWith(n)) return 80;
  if (n.includes(q) || q.includes(n)) return 60;
  const qWords = q.split(" ").filter(Boolean);
  if (qWords.length && qWords.every((w) => n.includes(w))) return 50;
  const overlap = qWords.filter((w) => n.includes(w)).length;
  if (overlap && overlap / qWords.length >= 0.6) return 30;
  return 0;
}

function pickControl(query, controls) {
  let best = null;
  let bestScore = 0;
  for (const control of controls || []) {
    const score = scoreControl(query, control);
    if (score > bestScore) {
      best = control;
      bestScore = score;
    }
  }
  return bestScore >= 30 ? { control: best, score: bestScore } : null;
}

function buildInstruction({ target, windowTitle, processName, match }) {
  const where = windowTitle
    ? `in “${windowTitle}”`
    : processName
      ? `in ${processName}`
      : "on the screen";
  if (match?.control) {
    const c = match.control;
    const kind = (c.type || "control").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return `In ${where}, look for the ${kind} labelled “${c.name}”. I highlighted it for a few seconds.`;
  }
  return `I could not find a control named “${target}” ${where}. Check the menus and toolbar in that window.`;
}

function parseLocatorOutput(stdout) {
  const raw = String(stdout || "").trim();
  const start = raw.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

async function locateGuideTarget(target, deps = {}) {
  const {
    platform = process.platform,
    execFile,
    timeout = 8000,
    overlayProcessNames = ["overlay", "electron"],
  } = deps;
  if (platform !== "win32") {
    return {
      ok: false,
      code: "UNSUPPORTED",
      instruction: "On-screen guidance is only available on Windows.",
    };
  }
  if (typeof execFile !== "function") {
    return { ok: false, code: "FAILED", instruction: "On-screen guidance is not available." };
  }
  let stdout = "";
  try {
    const result = await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        UIA_SCRIPT,
      ],
      { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
    );
    stdout = result && result.stdout != null ? result.stdout : result || "";
  } catch (error) {
    stdout = error && error.stdout ? error.stdout : "";
    if (!stdout) {
      return {
        ok: false,
        code: "FAILED",
        instruction: `I could not inspect the screen (${error.message || "UI Automation failed"}). Try describing the button in more detail.`,
        error: error.message,
      };
    }
  }
  const data = parseLocatorOutput(stdout) || {};
  const processName = String(data.processName || "");
  const skip = overlayProcessNames.some((n) => processName.toLowerCase() === String(n).toLowerCase());
  const controls = skip ? [] : Array.isArray(data.controls) ? data.controls : [];
  const match = pickControl(target, controls);
  const instruction = buildInstruction({
    target,
    windowTitle: skip ? "" : data.title,
    processName: skip ? "" : processName,
    match,
  });
  return {
    ok: true,
    windowTitle: skip ? "" : data.title || "",
    processName: skip ? "" : processName,
    pid: data.pid,
    control: match?.control || null,
    bounds: match?.control
      ? { x: match.control.x, y: match.control.y, w: match.control.w, h: match.control.h }
      : null,
    instruction,
    scanned: controls.length,
  };
}

module.exports = {
  locateGuideTarget,
  pickControl,
  scoreControl,
  buildInstruction,
  parseLocatorOutput,
  normalize,
};

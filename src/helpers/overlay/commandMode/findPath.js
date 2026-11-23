// Find a file or folder by name and open it. Pure search + grammar; IO is injected.

const path = require("path");
const os = require("os");

const SKIP_DIR_RE =
  /^(windows|windows\.old|program files|program files \(x86\)|programdata|appdata|node_modules|\$recycle\.bin|system volume information|recovery|\$windows\.\~bt|\.git)$/i;
const EXECUTABLE_RE = /\.(exe|bat|cmd|com|msi|ps1|scr|msc)$/i;
const DEFAULT_TIMEOUT_MS = 3000;
const KNOWN_FOLDER_NAMES = ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"];
const FILE_MANAGER_RE = /(?:file\s+)?explorer|windows\s+explorer|\bfiles\b/i;

function trimText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripWrappers(text) {
  return trimText(text)
    .replace(/[?!.,]+$/g, "")
    .replace(/^(?:please|pls|plz|can you|could you|would you|will you|can u|could u|just)\s+/i, "")
    .trim();
}

function normalizeKind(value) {
  const t = String(value || "any").toLowerCase();
  if (/^(folder|directory|dir)$/.test(t)) return "folder";
  if (/^(file)$/.test(t)) return "file";
  return "any";
}

function basenameOf(p) {
  return path.basename(String(p || "")).replace(/[/\\]+$/, "");
}

function normalizeName(value) {
  return trimText(value)
    .replace(/^[“”"']+|[“”"']+$/g, "")
    .replace(/\s+(folder|directory|dir|file)s?$/i, "")
    .trim();
}

function isExecutablePath(filePath) {
  return EXECUTABLE_RE.test(String(filePath || ""));
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array(t.length + 1);
  const cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = cur[j];
  }
  return prev[t.length];
}

function scoreName(name, candidate, kind, entryKind, depth) {
  const want = String(name || "").toLowerCase();
  const got = String(candidate || "").toLowerCase();
  if (!want || !got) return 0;
  let score = 0;
  if (got === want) score = 100;
  else if (got.startsWith(want)) score = 80;
  else if (got.includes(want)) score = 60;
  else {
    const dist = levenshtein(want, got);
    const allowed = want.length <= 3 ? 1 : 2;
    if (dist <= allowed) score = 40 - dist * 5;
  }
  if (!score) return 0;
  if (kind === "folder" && entryKind === "folder") score += 8;
  if (kind === "file" && entryKind === "file") score += 8;
  if (kind === "folder" && entryKind === "file") score -= 20;
  if (kind === "file" && entryKind === "folder") score -= 20;
  score -= Math.min(depth, 10);
  return score;
}

function stripFileManagerPhrases(text) {
  return String(text || "").replace(FILE_MANAGER_RE, " ");
}

function looksLikeExplorerSearchMs(text) {
  const t = stripWrappers(text);
  if (!t) return false;
  const rest = stripFileManagerPhrases(t);
  // "open file explorer and search for X folder" is a path find, not search-ms.
  // Ignore the word "file" inside "file explorer" when deciding that.
  if (/\b(folder|directory|file)s?\b/i.test(rest) && FILE_MANAGER_RE.test(t) && /\b(and\s+)?search\s+for\b/i.test(t)) {
    return false;
  }
  return (
    /\bsearch\s+(?:for\s+)?(?:it\s+)?in\s+(?:the\s+)?(?:file\s+)?explorer\b/i.test(t) ||
    /\bsearch\s+(?:for\s+)?.+?\s+in\s+(?:the\s+)?(?:file\s+)?explorer\b/i.test(t) ||
    /\bsearch\s+in\s+(?:the\s+)?(?:file\s+)?explorer\s+(?:for\s+)?/i.test(t) ||
    /\b(?:in|using|with|via)\s+(?:the\s+)?(?:file\s+)?explorer(?:'s)?\s+(?:to\s+)?search\s+(?:for\s+)?/i.test(t) ||
    /\buse\s+(?:file\s+)?explorer(?:'s)?\s+(?:to\s+)?search\s+(?:for\s+)?/i.test(t) ||
    /\b(?:file\s+)?explorer\s+search(?:-ms)?\s+(?:for\s+)?/i.test(t)
  );
}

function parseExplorerSearchMs(text) {
  if (!looksLikeExplorerSearchMs(text)) return null;
  const t = stripWrappers(text);
  const m =
    t.match(/\bsearch\s+in\s+(?:the\s+)?(?:file\s+)?explorer\s+(?:for\s+)?(.+?)(?:\s+(?:under|in|inside|within)\s+(?:the\s+)?(.+))?$/i) ||
    t.match(/\bsearch(?:-ms)?\s+(?:for\s+)?(.+?)(?:\s+(?:in|inside|within|under)\s+(?:the\s+)?(.+))?$/i) ||
    t.match(/\bsearch\s+(?:for\s+)?(.+)$/i);
  const query = normalizeName(m ? m[1] : "");
  if (!query) return null;
  let location = m && m[2] ? normalizeName(m[2]) : "";
  if (location && FILE_MANAGER_RE.test(location) && !/[/\\]/.test(location)) location = "";
  return {
    action: "open_path",
    args: { searchQuery: query, location, searchMs: true },
    confidence: 0.9,
  };
}

function parseFindPath(text) {
  const raw = stripWrappers(text);
  if (!raw) return null;
  if (looksLikeExplorerSearchMs(raw)) return parseExplorerSearchMs(raw);

  const nested = raw.match(
    /^(?:open|find|locate|search\s+for|kholo|dhundo)\s+(?:the\s+)?(.+?)\s+(folder|directory|dir|file)s?\s+(?:in|inside|under|within)\s+(?:the\s+)?(.+?)(?:\s+(folder|directory|dir|file)s?)?$/i
  );
  if (nested) {
    const name = normalizeName(nested[1]);
    const within = normalizeName(nested[3]);
    if (name && within) {
      return {
        action: "find_path",
        args: { name, kind: normalizeKind(nested[2]), within },
        confidence: 0.94,
      };
    }
  }

  const explorerAndSearch = raw.match(
    /^(?:open|launch|start|kholo|chalao)\s+(?:the\s+)?(?:file\s+)?explorer(?:\s+window)?\s+(?:and\s+(?:then\s+)?|then\s+|aur\s+|phir\s+)?(?:search|find|look\s*up|dhundo)\s+(?:for\s+)?(.+)$/i
  );
  if (explorerAndSearch) {
    const rest = trimText(explorerAndSearch[1]);
    const kindMatch = rest.match(/^(?:the\s+)?(.+?)\s+(folder|directory|dir|file)s?$/i);
    const name = normalizeName(kindMatch ? kindMatch[1] : rest);
    const kind = kindMatch ? normalizeKind(kindMatch[2]) : "any";
    if (name) return { action: "find_path", args: { name, kind }, confidence: 0.93 };
  }

  const findKind = raw.match(
    /^(?:find|locate|search\s+for|dhundo|open)\s+(?:the\s+)?(.+?)\s+(folder|directory|dir|file)s?$/i
  );
  if (findKind) {
    const name = normalizeName(findKind[1]);
    // Don't steal "open chrome" / "open notepad" — those have no folder/file word.
    if (name && !/^(file\s+)?explorer$/i.test(name)) {
      return {
        action: "find_path",
        args: { name, kind: normalizeKind(findKind[2]) },
        confidence: 0.92,
      };
    }
  }

  return null;
}

function defaultKnownRoots({ env = process.env, fsImpl, platform = process.platform } = {}) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const roots = [];
  const seen = new Set();
  const push = (p) => {
    const resolved = path.resolve(p);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!fsImpl || typeof fsImpl.existsSync !== "function" || fsImpl.existsSync(resolved)) {
      roots.push(resolved);
    }
  };
  if (home) {
    for (const name of KNOWN_FOLDER_NAMES) push(path.join(home, name));
    push(home);
    const oneDrive = env.OneDrive || path.join(home, "OneDrive");
    push(oneDrive);
  }
  return roots;
}

function defaultFixedDrives({ fsImpl, platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  const drives = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    if (!fsImpl || typeof fsImpl.existsSync !== "function" || fsImpl.existsSync(root)) drives.push(root);
  }
  return drives;
}

function shouldSkipDir(name) {
  return SKIP_DIR_RE.test(String(name || ""));
}

async function readDir(fsImpl, dir) {
  const reader = fsImpl.promises?.readdir || fsImpl.readdir;
  if (typeof reader !== "function") return [];
  try {
    const entries = await reader.call(fsImpl.promises || fsImpl, dir, { withFileTypes: true });
    return entries || [];
  } catch {
    return [];
  }
}

function entryKind(entry) {
  if (!entry) return "file";
  if (typeof entry.isDirectory === "function") return entry.isDirectory() ? "folder" : "file";
  if (entry.isDirectory === true) return "folder";
  return "file";
}

async function walkAndScore({
  roots,
  name,
  kind,
  fsImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxDepth = 8,
  now = () => Date.now(),
}) {
  const start = now();
  const matches = [];
  const seen = new Set();
  for (const root of roots || []) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      if (now() - start > timeoutMs) return { matches, timedOut: true };
      const { dir, depth } = queue.shift();
      const key = String(dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entries = await readDir(fsImpl, dir);
      for (const entry of entries) {
        const entryName = entry.name || entry;
        const full = path.join(dir, String(entryName));
        const typ = entryKind(entry);
        if (typ === "folder" && shouldSkipDir(entryName)) continue;
        const score = scoreName(name, entryName, kind, typ, depth);
        if (score > 0 && (kind === "any" || typ === kind)) {
          matches.push({ path: full, name: String(entryName), kind: typ, score, depth });
        }
        if (typ === "folder" && depth < maxDepth) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }
  return { matches, timedOut: false };
}

function dedupeAndRank(matches) {
  const best = new Map();
  for (const item of matches || []) {
    const key = String(item.path || "").toLowerCase();
    if (!key) continue;
    const prev = best.get(key);
    if (!prev || item.score > prev.score) best.set(key, item);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.depth - b.depth || a.path.localeCompare(b.path));
}

async function findPaths(name, options = {}) {
  const kind = normalizeKind(options.kind);
  const query = normalizeName(name);
  const within = normalizeName(options.within || "");
  const fsImpl = options.fsImpl;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const now = options.now || (() => Date.now());
  const start = now();
  if (!query) return { matches: [], query, kind, within };

  let scopeRoots = options.roots;
  if (within) {
    const parent = await findPaths(within, {
      ...options,
      within: "",
      kind: "folder",
      timeoutMs: Math.max(500, timeoutMs / 2),
    });
    if (!parent.matches.length) return { matches: [], query, kind, within, missingWithin: within };
    scopeRoots = parent.matches.map((row) => row.path);
  }

  const collected = [];
  if (typeof options.searchIndex === "function") {
    try {
      const indexed = await options.searchIndex({ name: query, kind, roots: scopeRoots, remainingMs: timeoutMs });
      for (const row of indexed || []) {
        const typ = row.kind || (row.isDirectory ? "folder" : "file");
        const score = scoreName(query, row.name || basenameOf(row.path), kind, typ, row.depth || 0);
        if (score > 0) collected.push({ path: row.path, name: row.name || basenameOf(row.path), kind: typ, score, depth: row.depth || 0 });
      }
    } catch {
      // Fall through to a directory walk.
    }
  }

  const remaining = Math.max(200, timeoutMs - (now() - start));
  const known = scopeRoots || defaultKnownRoots({ env: options.env, fsImpl, platform: options.platform });
  const walked = await walkAndScore({
    roots: known,
    name: query,
    kind,
    fsImpl,
    timeoutMs: remaining,
    maxDepth: options.maxDepth || 8,
    now,
  });
  collected.push(...walked.matches);

  let ranked = dedupeAndRank(collected);
  const exact = ranked.filter((row) => row.name.toLowerCase() === query.toLowerCase());
  if (!scopeRoots && exact.length === 0 && options.searchDrives !== false) {
    const drives = options.drives || defaultFixedDrives({ fsImpl, platform: options.platform });
    const more = await walkAndScore({
      roots: drives.filter((d) => !known.some((k) => String(k).toLowerCase().startsWith(String(d).toLowerCase()))),
      name: query,
      kind,
      fsImpl,
      timeoutMs: Math.max(200, timeoutMs - (now() - start)),
      maxDepth: options.driveMaxDepth || 5,
      now,
    });
    ranked = dedupeAndRank(collected.concat(more.matches));
  }

  return { matches: ranked, query, kind, within };
}

function formatFindList(matches, { limit = 5 } = {}) {
  return (matches || [])
    .slice(0, limit)
    .map((row, i) => `${i + 1}. ${row.path}`)
    .join("\n");
}

function formatFindOutcome(result) {
  const name = result?.query || "that";
  const matches = result?.matches || [];
  if (result?.missingWithin) {
    return `I couldn't find a folder named "${result.missingWithin}" to look inside.`;
  }
  if (!matches.length) return `I couldn't find a ${result?.kind === "file" ? "file" : result?.kind === "folder" ? "folder" : "file or folder"} named "${name}".`;
  if (matches.length === 1) return `Found ${matches[0].path}`;
  return `I found ${matches.length} matches for "${name}". Pick a number:\n${formatFindList(matches)}`;
}

function explorerSearchMsUrl(query, location) {
  const q = encodeURIComponent(String(query || "").trim());
  if (!q) return "";
  const loc = location ? `&crumb=location:${String(location)}` : "";
  return `search-ms:query=${q}${loc}`;
}

function buildWindowsSearchSql({ name, kind, roots } = {}) {
  const safe = String(name || "").replace(/'/g, "''").replace(/"/g, "");
  if (!safe) return "";
  let filter = `CONTAINS(System.FileName, '"${safe}*"')`;
  if (kind === "folder") filter += " AND System.Kind = 'folder'";
  else if (kind === "file") filter += " AND System.Kind <> 'folder'";
  const scopes = (roots || [])
    .slice(0, 8)
    .map((root) => `SCOPE='file:${String(root).replace(/'/g, "''")}'`);
  if (scopes.length) filter += ` AND (${scopes.join(" OR ")})`;
  return `SELECT TOP 20 System.ItemPathDisplay, System.ItemName, System.Kind FROM SYSTEMINDEX WHERE ${filter}`;
}

async function queryWindowsSearch(execFile, options = {}) {
  if (typeof execFile !== "function") return [];
  const payload = Buffer.from(
    JSON.stringify({
      name: normalizeName(options.name || ""),
      kind: normalizeKind(options.kind),
      roots: options.roots || [],
    }),
    "utf8"
  ).toString("base64");
  if (!options.name && !payload) return [];
  const timeout = Math.max(400, Math.min(Number(options.remainingMs) || 2000, 3000));
  const script = `
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
$opts = $payload | ConvertFrom-Json
$name = [string]$opts.name
if (-not $name) { '[]'; exit 0 }
$safe = $name.Replace("'", "''").Replace('"','')
$filter = "CONTAINS(System.FileName, '" + '"' + $safe + '*"' + "')"
if ($opts.kind -eq 'folder') { $filter += " AND System.Kind = 'folder'" }
elseif ($opts.kind -eq 'file') { $filter += " AND System.Kind <> 'folder'" }
$scopes = @()
foreach ($root in @($opts.roots)) {
  if ($root) { $scopes += ("SCOPE='file:" + ([string]$root).Replace("'", "''") + "'") }
}
if ($scopes.Count -gt 0) { $filter += " AND (" + ($scopes -join " OR ") + ")" }
$sql = "SELECT TOP 20 System.ItemPathDisplay, System.ItemName, System.Kind FROM SYSTEMINDEX WHERE $filter"
$conn = New-Object -ComObject ADODB.Connection
$rs = New-Object -ComObject ADODB.Recordset
try {
  $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  $rs.Open($sql, $conn)
  $rows = @()
  while (-not $rs.EOF) {
    $itemPath = [string]$rs.Fields.Item('System.ItemPathDisplay').Value
    $itemName = [string]$rs.Fields.Item('System.ItemName').Value
    $itemKind = [string]$rs.Fields.Item('System.Kind').Value
    $kind = if ($itemKind -match 'folder') { 'folder' } else { 'file' }
    $rows += @{ path = $itemPath; name = $itemName; kind = $kind }
    $rs.MoveNext()
  }
  if ($rows.Count -eq 0) { '[]' } else { $rows | ConvertTo-Json -Compress }
} finally {
  try { $rs.Close() } catch {}
  try { $conn.Close() } catch {}
}
`;
  try {
    const result = await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, timeout }
    );
    const stdout = typeof result === "string" ? result : result?.stdout || "";
    const trimmed = String(stdout || "").trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

module.exports = {
  parseFindPath,
  buildWindowsSearchSql,
  queryWindowsSearch,
  parseExplorerSearchMs,
  looksLikeExplorerSearchMs,
  findPaths,
  formatFindOutcome,
  formatFindList,
  scoreName,
  isExecutablePath,
  defaultKnownRoots,
  defaultFixedDrives,
  explorerSearchMsUrl,
  normalizeKind,
  normalizeName,
  SKIP_DIR_RE,
  DEFAULT_TIMEOUT_MS,
};

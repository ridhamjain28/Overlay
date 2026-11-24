// Windows app launch index, resolver and executor.
// Discovers installed apps from Start Menu shortcuts, App Paths registry,
// Get-StartApps AUMIDs (including Store apps like Spotify & Lenovo Vantage),
// and registered protocols, providing fuzzy alias and name resolution.

const path = require("path");
const childProcess = require("child_process");

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
  vantage: "lenovo vantage",
  "lenovo vantage": "lenovo vantage",
};

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

function canonicalAppName(value) {
  const name = normalizeName(value);
  if (!name) return name;
  if (APP_ALIASES[name]) return APP_ALIASES[name];
  const collapsed = name.replace(/\s+/g, "");
  if (APP_ALIASES[collapsed]) return APP_ALIASES[collapsed];
  return name;
}

function slugify(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "app";
}

function isUriScheme(str) {
  if (!str || typeof str !== "string") return false;
  // Windows absolute paths starting with "C:\" or "C:/" are NOT URIs
  if (/^[a-zA-Z]:[\\/]/.test(str)) return false;
  // File extensions or relative paths
  if (str.includes("\\")) return false;
  return /^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(str) || /^[a-z][a-z0-9+.-]*:\/\//i.test(str);
}

/**
 * Normalizes app targets and wraps them into a launch descriptor.
 */
function createLaunchDescriptor(app) {
  if (app.launch && app.launch.type && app.launch.target) {
    return { type: app.launch.type, target: String(app.launch.target) };
  }
  if (app.aumid || (app.target && String(app.target).toLowerCase().startsWith("shell:appsfolder\\"))) {
    const aumid = app.aumid || String(app.target).replace(/^shell:appsfolder\\/i, "");
    return {
      type: "shell",
      target: `shell:AppsFolder\\${aumid}`,
    };
  }
  if (app.protocols && app.protocols[0]) {
    const proto = app.protocols[0].endsWith(":") ? app.protocols[0] : `${app.protocols[0]}:`;
    return { type: "uri", target: proto };
  }
  if (app.type === "shortcut" || (app.target && /\.lnk$/i.test(app.target))) {
    return { type: "shortcut", target: app.target };
  }
  if (app.type === "uri" || (app.target && isUriScheme(app.target))) {
    return { type: "uri", target: app.target };
  }
  return {
    type: "exe",
    target: app.target || (app.exeName ? `${app.exeName}` : ""),
  };
}

/**
 * Builds a search index of launchable apps.
 * Ingests shortcuts, App Paths, StartApps (AUMIDs), protocols, and built-ins.
 */
function buildLaunchIndex(options = {}) {
  const index = [];
  const seenIds = new Set();

  function addEntry(entry) {
    if (!entry || !entry.name) return;
    const appId = entry.appId || entry.id || slugify(entry.name);
    const key = `${entry.launch.type}:${entry.launch.target}`.toLowerCase();
    if (seenIds.has(key)) return;
    seenIds.add(key);

    const normName = normalizeName(entry.name);
    const aliases = Array.from(
      new Set(
        [
          ...(entry.aliases || []),
          normName,
          slugify(entry.name),
          canonicalAppName(entry.name),
        ]
          .filter(Boolean)
          .map(normalizeName)
      )
    );

    index.push({
      appId,
      name: entry.name,
      normalizedName: normName,
      aliases,
      launch: entry.launch,
      source: entry.source || "unknown",
      // Backwards-compatible properties:
      type: entry.launch.type,
      target: entry.launch.target,
      label: entry.name,
    });
  }

  // 1. Built-in apps
  for (const [key, builtin] of Object.entries(BUILTIN_APPS)) {
    addEntry({
      appId: slugify(builtin.label || key),
      name: builtin.label || key,
      aliases: [key, normalizeName(builtin.label || key)],
      launch: { type: builtin.type, target: builtin.target },
      source: "builtin",
    });
  }

  // 2. Start menu shortcuts
  for (const s of options.shortcuts || []) {
    const rawName = s.name || path.basename(s.path || "", ".lnk");
    if (isBlockedApp(rawName)) continue;
    addEntry({
      appId: slugify(rawName),
      name: rawName,
      aliases: s.aliases || [normalizeName(rawName)],
      launch: createLaunchDescriptor({
        type: "shortcut",
        target: s.path || s.target,
      }),
      source: "start_menu",
    });
  }

  // 3. App Paths registry
  for (const ap of options.appPaths || []) {
    const exe = String(ap.exe || ap.Name || "");
    const target = String(ap.path || ap.Path || "");
    const name = exe.replace(/\.exe$/i, "");
    if (isBlockedApp(name)) continue;
    addEntry({
      appId: slugify(name),
      name,
      aliases: [normalizeName(name), exe.toLowerCase()],
      launch: createLaunchDescriptor({
        type: "exe",
        target: target || exe,
        exeName: exe,
      }),
      source: "app_paths",
    });
  }

  // 4. StartApps (UWP / MSIX Store apps like Spotify, Lenovo Vantage)
  for (const sa of options.startApps || []) {
    const name = String(sa.Name || sa.name || "");
    const aumid = String(sa.AppID || sa.AppId || sa.aumid || "");
    if (!name && !aumid) continue;
    if (isBlockedApp(name)) continue;
    addEntry({
      appId: slugify(name || aumid),
      name: name || aumid,
      aliases: [normalizeName(name || aumid), slugify(name || aumid)],
      launch: createLaunchDescriptor({
        type: "shell",
        aumid,
        target: aumid ? `shell:AppsFolder\\${aumid}` : "",
      }),
      source: "start_apps",
    });
  }

  // 5. Registered protocols
  for (const pr of options.protocols || []) {
    const protocol = String(pr.protocol || pr.Protocol || "").replace(/:$/, "");
    if (!protocol) continue;
    addEntry({
      appId: slugify(protocol),
      name: protocol,
      aliases: [normalizeName(protocol)],
      launch: createLaunchDescriptor({
        type: "uri",
        protocols: [`${protocol}:`],
        target: `${protocol}:`,
      }),
      source: "protocol",
    });
  }

  // 6. Custom skills / apps
  for (const ca of options.customApps || []) {
    if (!ca || !ca.name) continue;
    const launch = ca.launch || (ca.actions && ca.actions[0]?.how ? {
      type: ca.actions[0].how.type,
      target: ca.actions[0].how.template,
    } : { type: "exe", target: ca.target || "" });
    addEntry({
      appId: ca.appId || slugify(ca.name),
      name: ca.name,
      aliases: ca.aliases || [],
      launch: createLaunchDescriptor({ ...ca, launch }),
      source: "custom",
    });
  }

  return index;
}

/**
 * Computes the Optimal String Alignment (restricted Damerau-Levenshtein)
 * edit distance between two strings, treating adjacent transpositions as 1 edit.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev2 = new Int32Array(n + 1);
  let prev1 = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);

  for (let j = 0; j <= n; j++) prev1[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      let val = Math.min(
        prev1[j] + 1,
        curr[j - 1] + 1,
        prev1[j - 1] + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        ai === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        val = Math.min(val, prev2[j - 2] + 1);
      }
      curr[j] = val;
    }
    const tmp = prev2;
    prev2 = prev1;
    prev1 = curr;
    curr = tmp;
  }

  return prev1[n];
}

function fuzzyEditScore(query, candidate) {
  if (!query || !candidate || query.length < 3 || candidate.length < 3) return 0;
  const maxLen = Math.max(query.length, candidate.length);
  if (maxLen < 4) return 0;

  const maxEdits = maxLen <= 6 ? 1 : Math.min(3, Math.max(2, Math.floor(maxLen * 0.3)));
  if (Math.abs(query.length - candidate.length) > maxEdits) return 0;

  const dist = editDistance(query, candidate);
  if (dist > maxEdits) return 0;

  const similarity = 1 - dist / maxLen;
  const normalized = Math.max(0, Math.min(1, (similarity - 0.5) / 0.5));
  return 0.55 + normalized * 0.19;
}

/**
 * Calculates a match score between query and a candidate entry.
 * Returns a number between 0 and 1.
 */
function scoreMatch(query, entry) {
  const q = normalizeName(query);
  if (!q || isBlockedApp(q)) return 0;

  const targetName = entry.normalizedName;
  const canonicalQ = canonicalAppName(q);

  // Exact match on normalized name or appId
  if (targetName === q || entry.appId.toLowerCase() === q.replace(/\s+/g, "-")) {
    return 1.0;
  }

  // Canonical name match (e.g. calc -> calculator, vantage -> lenovo vantage)
  if (targetName === canonicalQ || entry.aliases.includes(canonicalQ)) {
    return 0.95;
  }

  // Exact match on any alias
  if (entry.aliases.includes(q)) {
    return 0.95;
  }

  // Word boundary / word subset match
  // e.g. "vantage" matches "lenovo vantage"
  const qWords = q.split(/\s+/).filter(Boolean);
  const nameWords = targetName.split(/\s+/).filter(Boolean);

  const allQWordsInName = qWords.every((qw) => nameWords.includes(qw));
  if (allQWordsInName) {
    // If every query word is in the target name, score depends on how close in length they are
    const ratio = q.length / targetName.length;
    return Math.min(0.92, 0.8 + ratio * 0.12);
  }

  // Target name starts with query
  if (targetName.startsWith(q)) {
    return 0.85;
  }

  // Any alias starts with query or word
  for (const alias of entry.aliases) {
    if (alias.startsWith(q)) return 0.82;
    if (alias.split(/\s+/).includes(q)) return 0.84;
  }

  // Target name contains query as substring
  if (targetName.includes(q)) {
    return 0.75;
  }

  // Fuzzy subsequence / char overlap and Damerau-Levenshtein edit-distance
  if (q.length < 3) return 0;

  let bestFuzzy = 0;

  // Check edit-distance against full targetName and each alias
  bestFuzzy = Math.max(bestFuzzy, fuzzyEditScore(q, targetName));
  for (const alias of entry.aliases) {
    bestFuzzy = Math.max(bestFuzzy, fuzzyEditScore(q, alias));
  }

  // Check edit-distance against individual words in multi-word names/aliases
  if (qWords.length === 1) {
    const candidateWords = new Set(nameWords);
    for (const alias of entry.aliases) {
      for (const w of alias.split(/\s+/)) {
        if (w) candidateWords.add(w);
      }
    }
    for (const word of candidateWords) {
      const wordScore = fuzzyEditScore(q, word);
      if (wordScore > 0) {
        bestFuzzy = Math.max(bestFuzzy, Math.max(0.55, wordScore - 0.03));
      }
    }
  }

  // Strict in-order subsequence fallback
  let qIdx = 0;
  for (let i = 0; i < targetName.length && qIdx < q.length; i++) {
    if (targetName[i] === q[qIdx]) qIdx++;
  }
  if (qIdx === q.length) {
    bestFuzzy = Math.max(bestFuzzy, 0.6);
  }

  return bestFuzzy;
}

/**
 * Resolves an app query against the launch index.
 * Returns: { appId, name, launch: { type, target }, score } or null.
 */
function resolveApp(name, options = {}) {
  if (!name || typeof name !== "string") return null;

  const index = options.index || buildLaunchIndex(options);
  let best = null;
  let highestScore = 0;

  for (const entry of index) {
    const score = scoreMatch(name, entry);
    if (score > highestScore && score >= 0.5) {
      highestScore = score;
      best = entry;
      if (score === 1.0) break; // Perfect match
    }
  }

  if (!best) return null;

  return {
    appId: best.appId,
    name: best.name,
    launch: {
      type: best.launch.type,
      target: best.launch.target,
    },
    score: Math.round(highestScore * 100) / 100,
    // Backwards-compatible fields for existing systemActions / tests:
    type: best.launch.type,
    target: best.launch.target,
    label: best.name,
  };
}

/**
 * Launches a resolved app.
 * Handles UWP / shell Store apps (explorer.exe shell:AppsFolder\<AUMID>),
 * URI protocols, shortcuts, and executable files.
 */
async function launchApp(resolved, deps = {}) {
  if (!resolved) {
    throw new Error("No app to launch");
  }

  const launch = resolved.launch || { type: resolved.type, target: resolved.target };
  if (!launch || !launch.target) {
    throw new Error(`Resolved app "${resolved.name || resolved.appId}" has no launch target`);
  }

  const execFile = deps.execFile;
  const spawn = deps.spawn || childProcess.spawn;

  function launchDetachedProcess(file, args = [], { ignoreExitCode1 = false } = {}) {
    if (typeof execFile === "function") {
      return new Promise((resolve, reject) => {
        execFile(file, args, { windowsHide: false, detached: true }, (err) => {
          if (err && !(ignoreExitCode1 && err.code === 1)) reject(err);
          else resolve({ ok: true });
        });
      });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        child = spawn(file, args, {
          windowsHide: false,
          detached: true,
          stdio: "ignore",
        });
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.unref();
        } catch {}
        resolve({ ok: true });
      }, 250);
      if (typeof timer.unref === "function") timer.unref();

      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code && code !== 0 && !(ignoreExitCode1 && code === 1)) {
          reject(new Error(`${file} exited with code ${code}`));
        } else {
          resolve({ ok: true });
        }
      });
    });
  }

  const openExternal = deps.openExternal || (async (uri) => {
    // Fallback if not inside Electron
    const runner = execFile || childProcess.execFile;
    return new Promise((res, rej) => {
      runner("rundll32.exe", ["url.dll,FileProtocolHandler", uri], { windowsHide: false }, (err) => {
        if (err) rej(err);
        else res();
      });
    });
  });
  const openPath = deps.openPath || (async (filePath) => {
    try {
      await launchDetachedProcess("explorer.exe", [filePath], { ignoreExitCode1: true });
      return "";
    } catch (err) {
      return err ? err.message : "Failed to open path";
    }
  });

  const target = launch.target;
  const type = launch.type;

  // Store apps / UWP apps launch via explorer.exe shell:AppsFolder\<AUMID>
  if (type === "shell" || target.toLowerCase().startsWith("shell:appsfolder\\")) {
    return launchDetachedProcess("explorer.exe", [target], { ignoreExitCode1: true });
  }

  if (type === "shortcut" || target.toLowerCase().endsWith(".lnk")) {
    const error = await openPath(target);
    if (error) {
      throw new Error(String(error));
    }
    return { ok: true };
  }

  if (type === "uri" || isUriScheme(target)) {
    await openExternal(target);
    return { ok: true };
  }

  // Executable — detached without timeout so the child process stays alive
  return launchDetachedProcess(target, []);
}

module.exports = {
  buildLaunchIndex,
  resolveApp,
  launchApp,
  scoreMatch,
  editDistance,
  createLaunchDescriptor,
};

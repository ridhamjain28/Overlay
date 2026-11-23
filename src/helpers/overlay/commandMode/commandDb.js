// Versioned command database: bundled file plus a disabled-by-default
// remoteUrl hook for a future cloud host. An empty remoteUrl never fetches.

const fs = require("fs");
const path = require("path");

const BUNDLED_DB_PATH = path.join(__dirname, "skills", "db", "overlay-command-db.json");

function normalizeMatch(match) {
  const src = match && typeof match === "object" ? match : {};
  return {
    exeNames: Array.isArray(src.exeNames) ? src.exeNames.map((v) => String(v)) : [],
    aumidPrefixes: Array.isArray(src.aumidPrefixes) ? src.aumidPrefixes.map((v) => String(v)) : [],
    protocols: Array.isArray(src.protocols) ? src.protocols.map((v) => String(v)) : [],
    displayNameRegexes: Array.isArray(src.displayNameRegexes)
      ? src.displayNameRegexes.map((v) => String(v))
      : [],
  };
}

function normalizeDb(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const apps = Array.isArray(data.apps) ? data.apps : [];
  return {
    version: Number.isFinite(Number(data.version)) ? Number(data.version) : 1,
    remoteUrl: data.remoteUrl == null ? "" : String(data.remoteUrl),
    apps: apps
      .filter((app) => app && app.appId)
      .map((app) => ({
        ...app,
        appId: String(app.appId),
        name: String(app.name || app.appId),
        aliases: Array.isArray(app.aliases) ? app.aliases.map((a) => String(a)) : [],
        match: normalizeMatch(app.match),
        alwaysAvailable: app.alwaysAvailable === true,
        kind: app.kind || (app.alwaysAvailable ? "web" : "app"),
        actions: Array.isArray(app.actions) ? app.actions : [],
      })),
  };
}

function loadBundledCommandDb(fsImpl = fs, bundledPath = BUNDLED_DB_PATH) {
  const raw = JSON.parse(fsImpl.readFileSync(bundledPath, "utf8"));
  return normalizeDb(raw);
}

function isRemoteEnabled(dbOrUrl) {
  if (typeof dbOrUrl === "string") return Boolean(dbOrUrl.trim());
  return Boolean(String(dbOrUrl?.remoteUrl || "").trim());
}

async function loadCommandDb(opts = {}) {
  const bundled = loadBundledCommandDb(opts.fsImpl || fs, opts.bundledPath || BUNDLED_DB_PATH);
  const remoteUrl = String(opts.remoteUrl != null ? opts.remoteUrl : bundled.remoteUrl || "").trim();
  if (!remoteUrl || typeof opts.fetchImpl !== "function") return bundled;
  try {
    const res = await opts.fetchImpl(remoteUrl);
    const data = res && typeof res.json === "function" ? await res.json() : res;
    if (data && Array.isArray(data.apps) && data.apps.length) return normalizeDb(data);
  } catch {
    // Fall back to the bundled file; the cloud host is optional.
  }
  return bundled;
}

function normalizeProtocol(value) {
  return String(value || "")
    .trim()
    .replace(/:$/, "")
    .toLowerCase();
}

function appMatchesTemplate(discovered, template) {
  if (!discovered || !template) return false;
  const match = template.match || normalizeMatch();
  const exe = String(discovered.exeName || path.basename(discovered.target || "")).toLowerCase();
  if (match.exeNames.some((name) => name.toLowerCase() === exe)) return true;
  const aumid = String(discovered.aumid || "");
  if (
    aumid &&
    match.aumidPrefixes.some((prefix) => aumid.toLowerCase().startsWith(String(prefix).toLowerCase()))
  ) {
    return true;
  }
  const protocols = (discovered.protocols || []).map(normalizeProtocol);
  if (match.protocols.some((protocol) => protocols.includes(normalizeProtocol(protocol)))) return true;
  const name = String(discovered.name || "");
  for (const pattern of match.displayNameRegexes) {
    try {
      if (name && new RegExp(pattern, "i").test(name)) return true;
    } catch {
      // Ignore invalid patterns in a bundled file rather than failing the scan.
    }
  }
  return false;
}

function findTemplatesForApp(db, discovered) {
  return (db?.apps || []).filter((template) => appMatchesTemplate(discovered, template));
}

function listAlwaysAvailable(db) {
  return (db?.apps || []).filter((app) => app.alwaysAvailable);
}

module.exports = {
  BUNDLED_DB_PATH,
  loadBundledCommandDb,
  loadCommandDb,
  isRemoteEnabled,
  normalizeDb,
  appMatchesTemplate,
  findTemplatesForApp,
  listAlwaysAvailable,
  normalizeProtocol,
};

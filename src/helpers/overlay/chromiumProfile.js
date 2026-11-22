// Last-used Chrome / Edge / Brave profile from Chromium "Local State".
// Never log profile directory names or account emails.

const fs = require("fs");
const path = require("path");

const PRODUCTS = Object.freeze({
  chrome: {
    userData: ["Google", "Chrome", "User Data"],
    exe: [
      ["PROGRAMFILES", "Google", "Chrome", "Application", "chrome.exe"],
      ["PROGRAMFILES(X86)", "Google", "Chrome", "Application", "chrome.exe"],
      ["LOCALAPPDATA", "Google", "Chrome", "Application", "chrome.exe"],
    ],
  },
  edge: {
    userData: ["Microsoft", "Edge", "User Data"],
    exe: [
      ["PROGRAMFILES", "Microsoft", "Edge", "Application", "msedge.exe"],
      ["PROGRAMFILES(X86)", "Microsoft", "Edge", "Application", "msedge.exe"],
    ],
  },
  brave: {
    userData: ["BraveSoftware", "Brave-Browser", "User Data"],
    exe: [
      ["PROGRAMFILES", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
      ["LOCALAPPDATA", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ],
  },
});

function chromiumProductFromAppName(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  if (/\bbrave\b/.test(n)) return "brave";
  if (/\bedge\b/.test(n) || n.includes("msedge") || n.includes("microsoft edge")) return "edge";
  if (/\bchrome\b/.test(n) || n.includes("chromium")) return "chrome";
  return null;
}

function parseChromiumLastProfileDirectory(localStateJson) {
  let data = localStateJson;
  if (typeof localStateJson === "string") {
    try {
      data = JSON.parse(localStateJson);
    } catch {
      return "Default";
    }
  }
  const last = data && data.profile && data.profile.last_used;
  if (typeof last === "string" && last.trim()) return last.trim();
  const cache = data && data.profile && data.profile.info_cache;
  if (cache && typeof cache === "object") {
    if (Object.prototype.hasOwnProperty.call(cache, "Default")) return "Default";
    const keys = Object.keys(cache);
    if (keys.length) return keys[0];
  }
  return "Default";
}

function chromiumUserDataDir(product, env = process.env) {
  const spec = PRODUCTS[product];
  const local = env.LOCALAPPDATA;
  if (!spec || !local) return null;
  return path.join(local, ...spec.userData);
}

function readLastProfileDirectory(userDataDir, fsImpl = fs) {
  if (!userDataDir) return "Default";
  try {
    const raw = fsImpl.readFileSync(path.join(userDataDir, "Local State"), "utf8");
    return parseChromiumLastProfileDirectory(raw);
  } catch {
    return "Default";
  }
}

function firstExistingPath(candidates, fsImpl = fs) {
  for (const candidate of candidates) {
    try {
      if (candidate && fsImpl.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function defaultChromiumExecutable(product, env = process.env, fsImpl = fs) {
  const spec = PRODUCTS[product];
  if (!spec) return null;
  const candidates = spec.exe.map((parts) => {
    const rootKey = parts[0];
    const root = env[rootKey];
    if (!root) return null;
    return path.join(root, ...parts.slice(1));
  });
  return firstExistingPath(candidates, fsImpl);
}

function chromiumLaunchArgs(profileDirectory, url) {
  const dir = typeof profileDirectory === "string" && profileDirectory.trim()
    ? profileDirectory.trim()
    : "Default";
  const args = [`--profile-directory=${dir}`];
  if (url) args.push(String(url));
  return args;
}

function resolveChromiumLaunch({ product, url, env = process.env, fsImpl = fs, executablePath } = {}) {
  const exe = executablePath || defaultChromiumExecutable(product, env, fsImpl);
  if (!exe) return null;
  const profileDirectory = readLastProfileDirectory(chromiumUserDataDir(product, env), fsImpl);
  return { exe, args: chromiumLaunchArgs(profileDirectory, url), product };
}

module.exports = {
  PRODUCTS,
  chromiumProductFromAppName,
  parseChromiumLastProfileDirectory,
  chromiumUserDataDir,
  readLastProfileDirectory,
  defaultChromiumExecutable,
  chromiumLaunchArgs,
  resolveChromiumLaunch,
};

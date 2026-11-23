const path = require("path");
const fs = require("fs");
const { loadCommandDb } = require("./commandMode/commandDb");
const { scanInstalledApps } = require("./appInventory");
const {
  buildPackFromScan,
  summarizePack,
  getCatalog,
  listLocalSkills,
  setSkillEnabled,
  readSkill,
} = require("./appSkillStore");
const { fillActionTemplate } = require("./appSkillTemplates");
const learned = require("./learnedStore");

function skillsDirFor(app) {
  return path.join(app.getPath("userData"), "skills");
}

async function rescanAndBuildPack({
  baseDir,
  fsImpl = fs,
  scanOpts = {},
  remoteUrl,
  fetchImpl,
  bundledPath,
  onProgress,
  now,
} = {}) {
  const db = await loadCommandDb({ remoteUrl, fetchImpl, bundledPath, fsImpl });
  const inventory = await scanInstalledApps({ ...scanOpts, onProgress, now });
  const pack = buildPackFromScan({
    catalogApps: inventory.apps,
    db,
    baseDir,
    fsImpl,
    now: inventory.scannedAt,
  });
  return { ...pack, summary: summarizePack(pack.catalog), inventory };
}

function listSkillsState(baseDir, fsImpl = fs) {
  const catalog = getCatalog(baseDir, fsImpl) || { version: 1, apps: [], scannedAt: null };
  const skills = listLocalSkills(baseDir, fsImpl);
  return { catalog, skills, summary: summarizePack(catalog) };
}

function catalogIsStale(baseDir, fsImpl = fs, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()) {
  const catalog = getCatalog(baseDir, fsImpl);
  if (!catalog || !catalog.scannedAt) return true;
  const then = Date.parse(catalog.scannedAt);
  if (!Number.isFinite(then)) return true;
  return now - then > maxAgeMs;
}

module.exports = {
  skillsDirFor,
  rescanAndBuildPack,
  listSkillsState,
  setSkillEnabled,
  readSkill,
  fillActionTemplate,
  catalogIsStale,
  learned,
};

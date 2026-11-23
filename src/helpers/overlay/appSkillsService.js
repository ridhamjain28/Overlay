const path = require("path");
const fs = require("fs");
const { loadCommandDb } = require("./commandMode/commandDb");
const { scanInstalledApps } = require("./appInventory");
const {
  buildPackFromScan,
  getCatalog,
  listLocalSkills,
  setSkillEnabled,
  readSkill,
  toScanResult,
} = require("./appSkillStore");
const { fillActionTemplate } = require("./appSkillTemplates");
const learned = require("./learnedStore");

function skillsDirFor(app) {
  return path.join(app.getPath("userData"), "skills");
}

function report(onProgress, phase, done, total = 6) {
  if (typeof onProgress === "function") onProgress({ phase, done, total });
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
  const inventory = await scanInstalledApps({
    ...scanOpts,
    now,
    onProgress: (progress) => {
      const phase = progress.phase || progress.stage;
      report(onProgress, phase, progress.done ?? progress.current ?? 0, progress.total || 6);
    },
  });
  report(onProgress, "matching", 5, 6);
  report(onProgress, "writing", 5, 6);
  const pack = buildPackFromScan({
    catalogApps: inventory.apps,
    db,
    baseDir,
    fsImpl,
    now: inventory.scannedAt,
  });
  report(onProgress, "writing", 6, 6);
  const scanResult = toScanResult(pack.catalog, pack.skills);
  return { ...pack, scanResult, inventory };
}

function listSkills(baseDir, fsImpl = fs) {
  return listLocalSkills(baseDir, fsImpl);
}

function getSummary(baseDir, fsImpl = fs) {
  const catalog = getCatalog(baseDir, fsImpl);
  if (!catalog) return null;
  return toScanResult(catalog, listLocalSkills(baseDir, fsImpl));
}

function listSkillsState(baseDir, fsImpl = fs) {
  const catalog = getCatalog(baseDir, fsImpl) || { version: 1, apps: [], scannedAt: null };
  const skills = listLocalSkills(baseDir, fsImpl);
  const scanResult = catalog.scannedAt ? toScanResult(catalog, skills) : null;
  return { catalog, skills, scanResult };
}

function catalogIsStale(baseDir, fsImpl = fs, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()) {
  const catalog = getCatalog(baseDir, fsImpl);
  if (!catalog || !catalog.scannedAt) return true;
  const then = Date.parse(catalog.scannedAt);
  if (!Number.isFinite(then)) return true;
  return now - then > maxAgeMs;
}

function setEnabled(baseDir, { appId, actionId, enabled }, fsImpl = fs) {
  return setSkillEnabled(baseDir, String(appId || ""), enabled === true, fsImpl, actionId);
}


async function testSkillAction({ skill, actionId, params, perform }) {
  if (!skill) return { ok: false, error: "Unknown app" };
  const resolvedActionId = String(
    actionId || (skill.actions || []).find((action) => action.id === "launch" || action.id === "open")?.id || ""
  );
  // Do not pre-confirm. Safe actions still auto-run via autoRunTrusted;
  // risk=confirm goes through the dispatcher's native confirmation dialog.
  const result = await perform(
    {
      action: "app_action",
      args: { appId: skill.appId, actionId: resolvedActionId, params: params || {} },
    },
    { autoRunTrusted: true }
  );
  return { ok: result?.success === true, error: result?.success ? undefined : result?.error };
}

module.exports = {
  skillsDirFor,
  rescanAndBuildPack,
  listSkillsState,
  listSkills,
  getSummary,
  setEnabled,
  testSkillAction,
  setSkillEnabled,
  readSkill,
  fillActionTemplate,
  catalogIsStale,
  toScanResult,
  learned,
};

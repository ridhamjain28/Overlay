import type {
  AppSkill,
  AppSkillAction,
  OverlayAppsApi,
  OverlayAppsScanProgress,
  ScanResult,
} from "../types/overlayApps";

/** Order the backend reports scan phases in. Used for the progress bar. */
export const OVERLAY_APPS_SCAN_PHASES = [
  "shortcuts",
  "apppaths",
  "startapps",
  "protocols",
  "matching",
  "writing",
] as const;

/** The bridge, or undefined in a build (or the browser dev server) that doesn't ship it. */
export function getOverlayAppsApi(): OverlayAppsApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.electronAPI?.overlayApps;
}

/** 0-100 across all phases. An unknown phase keeps the bar where it is (null). */
export function scanProgressPercent(progress: OverlayAppsScanProgress | null): number {
  if (!progress) return 0;
  const index = (OVERLAY_APPS_SCAN_PHASES as readonly string[]).indexOf(progress.phase);
  if (index === -1) return 0;
  const fraction =
    progress.total > 0 ? Math.min(1, Math.max(0, progress.done / progress.total)) : 0;
  return Math.round(((index + fraction) / OVERLAY_APPS_SCAN_PHASES.length) * 100);
}

export interface AppRow {
  appId: string;
  name: string;
  matched: boolean;
  actionsCount: number;
  enabled: boolean;
  source: string;
  aliases: string[];
  /** The full skill, when list() returned one for this app. */
  skill: AppSkill | null;
}

function compareRows(a: AppRow, b: AppRow): number {
  if (a.matched !== b.matched) return a.matched ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Join the scan summary (every app found, matched or not) with list() (the skills,
 * which carry actions). Matched apps sort first, then by name.
 */
export function mergeAppRows(summary: ScanResult | null, skills: AppSkill[]): AppRow[] {
  const byId = new Map<string, AppRow>();

  for (const app of summary?.apps ?? []) {
    byId.set(app.appId, {
      appId: app.appId,
      name: app.name,
      matched: app.matched,
      actionsCount: app.actionsCount,
      enabled: app.enabled,
      source: app.source,
      aliases: [],
      skill: null,
    });
  }

  for (const skill of skills) {
    const existing = byId.get(skill.appId);
    if (existing) {
      existing.skill = skill;
      existing.aliases = skill.aliases ?? [];
      existing.enabled = skill.enabled;
      existing.actionsCount = Math.max(existing.actionsCount, skill.actions?.length ?? 0);
      continue;
    }
    byId.set(skill.appId, {
      appId: skill.appId,
      name: skill.name,
      matched: (skill.actions?.length ?? 0) > 0,
      actionsCount: skill.actions?.length ?? 0,
      enabled: skill.enabled,
      source: "",
      aliases: skill.aliases ?? [],
      skill,
    });
  }

  return [...byId.values()].sort(compareRows);
}

/** Case-insensitive match on the app name or any alias. An empty query keeps everything. */
export function filterAppRows<T extends { name: string; aliases?: string[] }>(
  rows: T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      (row.aliases ?? []).some((alias) => alias.toLowerCase().includes(needle))
  );
}

/** Params the Test button sends: the first example's, or none. */
export function testParamsForAction(action: AppSkillAction): Record<string, unknown> {
  return action.examples?.[0]?.params ?? {};
}

/** Missing `enabled` on an action means enabled. */
export function isActionEnabled(action: AppSkillAction): boolean {
  return action.enabled !== false;
}

/** scannedAt / timestamp as a Date, or null if it isn't a usable time. */
export function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(
  value: string | number | null | undefined,
  locale?: string
): string | null {
  const date = toDate(value);
  if (!date) return null;
  try {
    return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString();
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "";
}

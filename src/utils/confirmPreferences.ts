/**
 * Remembers which delete confirmations the user asked us to stop showing
 * ("Don't ask me again"). Stored in localStorage so the choice survives
 * restarts; Settings > General > Delete confirmations turns them back on.
 */

export const CONFIRM_SKIP_KINDS = [
  "historyItem",
  "chatConversation",
  "emptyFolder",
  "localModel",
] as const;

export type ConfirmSkipKind = (typeof CONFIRM_SKIP_KINDS)[number];

export const CONFIRM_SKIPS_STORAGE_KEY = "skippedDeleteConfirmations";
export const CONFIRM_SKIPS_CHANGED_EVENT = "overlay-confirm-skips-changed";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function isKind(value: unknown): value is ConfirmSkipKind {
  return typeof value === "string" && (CONFIRM_SKIP_KINDS as readonly string[]).includes(value);
}

export function getSkippedConfirmations(
  storage: StorageLike | null = defaultStorage()
): ConfirmSkipKind[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CONFIRM_SKIPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? Array.from(new Set(parsed.filter(isKind))) : [];
  } catch {
    return [];
  }
}

function notifyChanged() {
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event(CONFIRM_SKIPS_CHANGED_EVENT));
    }
  } catch {
    // Non-browser environments have nothing to notify.
  }
}

function writeSkipped(kinds: ConfirmSkipKind[], storage: StorageLike | null) {
  if (!storage) return;
  try {
    if (kinds.length === 0) storage.removeItem(CONFIRM_SKIPS_STORAGE_KEY);
    else storage.setItem(CONFIRM_SKIPS_STORAGE_KEY, JSON.stringify(kinds));
  } catch {
    return;
  }
  notifyChanged();
}

export function isConfirmSkipped(
  kind: ConfirmSkipKind | undefined | null,
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!kind) return false;
  return getSkippedConfirmations(storage).includes(kind);
}

export function setConfirmSkipped(
  kind: ConfirmSkipKind,
  skipped: boolean,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!isKind(kind)) return;
  const current = getSkippedConfirmations(storage);
  const next = skipped
    ? Array.from(new Set([...current, kind]))
    : current.filter((k) => k !== kind);
  writeSkipped(next, storage);
}

/** Turn every delete confirmation back on. */
export function resetConfirmSkips(storage: StorageLike | null = defaultStorage()): void {
  writeSkipped([], storage);
}

/** Stop asking for every delete confirmation that offers "Don't ask me again". */
export function skipAllConfirmations(storage: StorageLike | null = defaultStorage()): void {
  writeSkipped([...CONFIRM_SKIP_KINDS], storage);
}

// Pure helper: reuse the current assistant chat if it was used recently.

const DEFAULT_ASSISTANT_CHAT_IDLE_MINUTES = 10;
const MIN_ASSISTANT_CHAT_IDLE_MINUTES = 1;
const MAX_ASSISTANT_CHAT_IDLE_MINUTES = 120;
const LAST_ACTIVITY_STORAGE_KEY = "assistantChatLastActivityAt";

function normalizeAssistantChatIdleMinutes(value, fallback = DEFAULT_ASSISTANT_CHAT_IDLE_MINUTES) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_ASSISTANT_CHAT_IDLE_MINUTES, Math.max(MIN_ASSISTANT_CHAT_IDLE_MINUTES, Math.round(n)));
}

/**
 * Reuse the current conversation when the last message was less than
 * `idleMinutes` minutes ago. At or after that idle window, start a new chat.
 */
function shouldReuseAssistantConversation({
  lastActivityAt,
  idleMinutes = DEFAULT_ASSISTANT_CHAT_IDLE_MINUTES,
  now = Date.now(),
} = {}) {
  const minutes = normalizeAssistantChatIdleMinutes(idleMinutes);
  if (lastActivityAt == null || lastActivityAt === "") return true;
  const last = Number(lastActivityAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last < minutes * 60 * 1000;
}

function readAssistantChatLastActivityAt(storage) {
  try {
    const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store) return 0;
    const raw = store.getItem(LAST_ACTIVITY_STORAGE_KEY);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function touchAssistantChatActivity({ now = Date.now(), storage } = {}) {
  try {
    const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store) return now;
    store.setItem(LAST_ACTIVITY_STORAGE_KEY, String(now));
    return now;
  } catch {
    return now;
  }
}

function clearAssistantChatActivity(storage) {
  try {
    const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store) return;
    store.removeItem(LAST_ACTIVITY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export {
  DEFAULT_ASSISTANT_CHAT_IDLE_MINUTES,
  MIN_ASSISTANT_CHAT_IDLE_MINUTES,
  MAX_ASSISTANT_CHAT_IDLE_MINUTES,
  LAST_ACTIVITY_STORAGE_KEY,
  normalizeAssistantChatIdleMinutes,
  shouldReuseAssistantConversation,
  readAssistantChatLastActivityAt,
  touchAssistantChatActivity,
  clearAssistantChatActivity,
};
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/overlay/assistantChatContinuity.js");

test("default idle window is 10 minutes and values are clamped", async () => {
  const { DEFAULT_ASSISTANT_CHAT_IDLE_MINUTES, normalizeAssistantChatIdleMinutes } = await load();
  assert.equal(DEFAULT_ASSISTANT_CHAT_IDLE_MINUTES, 10);
  assert.equal(normalizeAssistantChatIdleMinutes(undefined), 10);
  assert.equal(normalizeAssistantChatIdleMinutes(0), 1);
  assert.equal(normalizeAssistantChatIdleMinutes(9.6), 10);
  assert.equal(normalizeAssistantChatIdleMinutes(500), 120);
});

test("reuse the current chat when the last message was less than N minutes ago", async () => {
  const { shouldReuseAssistantConversation } = await load();
  const now = Date.parse("2026-11-23T00:00:00+05:30");
  const nineMin = now - 9 * 60 * 1000;
  const tenMin = now - 10 * 60 * 1000;
  const elevenMin = now - 11 * 60 * 1000;
  assert.equal(
    shouldReuseAssistantConversation({ lastActivityAt: nineMin, idleMinutes: 10, now }),
    true
  );
  assert.equal(
    shouldReuseAssistantConversation({ lastActivityAt: tenMin, idleMinutes: 10, now }),
    false
  );
  assert.equal(
    shouldReuseAssistantConversation({ lastActivityAt: elevenMin, idleMinutes: 10, now }),
    false
  );
  assert.equal(
    shouldReuseAssistantConversation({ lastActivityAt: elevenMin, idleMinutes: 15, now }),
    true
  );
});

test("missing last-activity timestamp is treated as reusable, not stale", async () => {
  const { shouldReuseAssistantConversation } = await load();
  assert.equal(shouldReuseAssistantConversation({ lastActivityAt: null, idleMinutes: 10 }), true);
  assert.equal(shouldReuseAssistantConversation({ lastActivityAt: 0, idleMinutes: 10 }), true);
});

test("activity helpers read and write a storage key", async () => {
  const {
    readAssistantChatLastActivityAt,
    touchAssistantChatActivity,
    LAST_ACTIVITY_STORAGE_KEY,
  } = await load();
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  assert.equal(readAssistantChatLastActivityAt(storage), 0);
  const now = 1_700_000_000_000;
  assert.equal(touchAssistantChatActivity({ now, storage }), now);
  assert.equal(storage.getItem(LAST_ACTIVITY_STORAGE_KEY), String(now));
  assert.equal(readAssistantChatLastActivityAt(storage), now);
});
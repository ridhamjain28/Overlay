const test = require("node:test");
const assert = require("node:assert/strict");

const {
  capChatMessages,
  MAX_LIVE_CHAT_MESSAGES,
} = require("../../src/components/chat/liveMessageCap.ts");

test("short histories are unchanged and long ones keep the newest turns", () => {
  const short = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  assert.equal(capChatMessages(short, 4), short);

  const many = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    id: i,
  }));
  const capped = capChatMessages(many, 4);
  assert.deepEqual(
    capped.map((m) => m.id),
    [6, 7, 8, 9]
  );
});

test("a cap does not start mid-turn on an assistant message", () => {
  const msgs = [
    { role: "user", id: 1 },
    { role: "assistant", id: 2 },
    { role: "user", id: 3 },
    { role: "assistant", id: 4 },
    { role: "user", id: 5 },
    { role: "assistant", id: 6 },
  ];
  // max=3 would start on assistant 4; skip it so the kept window begins at user 5.
  assert.deepEqual(
    capChatMessages(msgs, 3).map((m) => m.id),
    [5, 6]
  );
});

test("the default cap is large enough for a long session but finite", () => {
  assert.equal(MAX_LIVE_CHAT_MESSAGES, 200);
  const many = Array.from({ length: 250 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
  }));
  assert.ok(capChatMessages(many).length <= MAX_LIVE_CHAT_MESSAGES);
  assert.ok(capChatMessages(many).length >= MAX_LIVE_CHAT_MESSAGES - 1);
});

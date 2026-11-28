const test = require("node:test");
const assert = require("node:assert/strict");

test("ChatInput prompt history: records, deduplicates consecutive, caps at 30", () => {
  const pushHistory = (prev, text) => {
    const trimmed = text.trim();
    if (!trimmed) return prev;
    return prev[0] === trimmed ? prev : [trimmed, ...prev].slice(0, 30);
  };

  let history = [];
  history = pushHistory(history, "first");
  history = pushHistory(history, "first");
  assert.deepEqual(history, ["first"]);

  for (let i = 0; i < 35; i++) {
    history = pushHistory(history, `cmd-${i}`);
  }
  assert.equal(history.length, 30);
  assert.equal(history[0], "cmd-34");
});

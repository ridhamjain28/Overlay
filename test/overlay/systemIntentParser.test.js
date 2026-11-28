const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSystemCommand } = require("../../src/helpers/overlay/commandMode/systemIntentParser");
const { performSystemAction, scheduleReminder, activeTimers } = require("../../src/helpers/overlay/systemActions");

test("systemIntentParser: parses volume, media, brightness, screenshot, time, lock, timer, reminder", () => {
  assert.deepEqual(parseSystemCommand("volume up")?.action, "volume_up");
  assert.deepEqual(parseSystemCommand("turn down volume")?.action, "volume_down");
  assert.deepEqual(parseSystemCommand("mute")?.action, "volume_mute");
  assert.deepEqual(parseSystemCommand("set volume to 45%"), { action: "volume_set", args: { level: 45 }, confidence: 0.97 });
  assert.deepEqual(parseSystemCommand("play music")?.action, "media_play_pause");
  assert.deepEqual(parseSystemCommand("next track")?.action, "media_next");
  assert.deepEqual(parseSystemCommand("previous song")?.action, "media_previous");
  assert.deepEqual(parseSystemCommand("set brightness to 70"), { action: "brightness_set", args: { level: 70 }, confidence: 0.96 });
  assert.deepEqual(parseSystemCommand("take a screenshot")?.action, "screenshot");
  assert.deepEqual(parseSystemCommand("what time is it")?.action, "show_time");
  assert.deepEqual(parseSystemCommand("lock screen")?.action, "lock_screen");

  const timer = parseSystemCommand("set a timer for 5 minutes");
  assert.equal(timer?.action, "timer");
  assert.equal(timer?.args.durationMs, 300000);

  const rem = parseSystemCommand("remind me in 10 min to call mom");
  assert.equal(rem?.action, "reminder");
  assert.equal(rem?.args.durationMs, 600000);
  assert.equal(rem?.args.message, "call mom");

  assert.equal(parseSystemCommand("explain quantum computing"), null);
});

test("systemActions: show_time, lock_screen confirmation gate, and scheduleReminder", async () => {
  const timeRes = await performSystemAction({ action: "show_time" });
  assert.equal(timeRes.success, true);
  assert.match(timeRes.message, /^It's /);

  const lockDenied = await performSystemAction({ action: "lock_screen" }, { confirmed: false });
  assert.equal(lockDenied.success, false);
  assert.equal(lockDenied.code, "CONFIRM_REQUIRED");

  const remRes = scheduleReminder({ action: "timer", args: { durationMs: 5000, label: "tea" } });
  assert.equal(remRes.success, true);
  assert.ok(remRes.id);
  const handle = activeTimers.get(remRes.id);
  if (handle) clearTimeout(handle);
  activeTimers.delete(remRes.id);
});

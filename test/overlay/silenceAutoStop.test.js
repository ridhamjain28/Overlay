const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/silenceAutoStop.js");

const repeat = (value, count) => Array.from({ length: count }, () => value);

// Feeds RMS windows (100 ms each) and returns the first non-continue decision
// with the window index it happened on, or null.
const run = (mod, levels, peaks = null) => {
  const state = mod.createSilenceAutoStopState();
  for (let i = 0; i < levels.length; i++) {
    const d = mod.recordSilenceAutoStopWindow(state, levels[i], peaks ? peaks[i] : null);
    if (d.action !== "continue") return { ...d, index: i, elapsedMs: state.elapsedMs, state };
  }
  return null;
};

test("speech then 1.2 s of silence stops like a second hotkey press", async () => {
  const mod = await load();
  const levels = [...repeat(0.001, 5), ...repeat(0.04, 15), ...repeat(0.001, 30)];
  const d = run(mod, levels);
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "silence");
  // 12 quiet windows after speech = 1200 ms.
  assert.equal(d.index, 5 + 15 + 12 - 1);
});

test("never speaking cancels quietly after about 8 s", async () => {
  const mod = await load();
  const d = run(mod, repeat(0.001, 200));
  assert.equal(d.action, "cancel");
  assert.equal(d.reason, "no_speech");
  assert.equal(d.elapsedMs, 8000);
});

test("isolated noise blips never count as speech", async () => {
  const mod = await load();
  const levels = repeat(0.001, 200).map((v, i) => (i % 10 === 3 || i % 10 === 4 ? 0.05 : v));
  const d = run(mod, levels);
  assert.equal(d.action, "cancel");
  assert.equal(d.reason, "no_speech");
  assert.equal(d.state.speechStarted, false);
});

test("a pause under 1.2 s mid-sentence does not stop", async () => {
  const mod = await load();
  const sentence = [
    ...repeat(0.001, 3),
    ...repeat(0.04, 10),
    ...repeat(0.001, 11), // 1.1 s pause
    ...repeat(0.035, 10),
    ...repeat(0.001, 8), // 0.8 s pause
    ...repeat(0.03, 6),
  ];
  assert.equal(run(mod, sentence), null);
  const d = run(mod, [...sentence, ...repeat(0.001, 12)]);
  assert.equal(d.action, "stop");
  assert.equal(d.index, sentence.length + 11);
});

test("a blip during the trailing silence restarts the 1.2 s timer", async () => {
  const mod = await load();
  const levels = [...repeat(0.04, 10), ...repeat(0.001, 8), 0.05, ...repeat(0.001, 20)];
  const d = run(mod, levels);
  assert.equal(d.action, "stop");
  assert.equal(d.index, 10 + 8 + 1 + 12 - 1);
});

test("a noisy room still ends the question once speech drops back to the floor", async () => {
  const mod = await load();
  const levels = [...repeat(0.01, 10), ...repeat(0.08, 15), ...repeat(0.011, 20)];
  const d = run(mod, levels);
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "silence");
  assert.equal(d.index, 10 + 15 + 12 - 1);
});

test("windows with a tiny peak are not speech", async () => {
  const mod = await load();
  const levels = repeat(0.01, 100);
  const peaks = repeat(0.005, 100);
  const d = run(mod, levels, peaks);
  assert.equal(d.action, "cancel");
});

test("non-stop talking is capped at 60 s", async () => {
  const mod = await load();
  const d = run(mod, repeat(0.05, 700));
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "max_duration");
  assert.equal(d.elapsedMs, 60000);
});

test("with no analyser data it never cancels early, only the hard cap applies", async () => {
  const mod = await load();
  const d = run(mod, repeat(null, 700));
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "max_duration");
});

test("a decision is final", async () => {
  const mod = await load();
  const state = mod.createSilenceAutoStopState({ noSpeechTimeoutMs: 300 });
  let d;
  for (let i = 0; i < 3; i++) d = mod.recordSilenceAutoStopWindow(state, 0.001);
  assert.equal(d.action, "cancel");
  assert.equal(mod.recordSilenceAutoStopWindow(state, 0.2).action, "cancel");
});

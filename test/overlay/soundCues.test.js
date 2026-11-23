const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/overlay/soundCues.ts");

function createMockAudioContext(initialState = "running") {
  const oscillators = [];
  const gains = [];

  class MockParam {
    constructor(defaultValue = 0) {
      this.value = defaultValue;
      this.calls = [];
    }
    setValueAtTime(val, time) {
      this.calls.push({ method: "setValueAtTime", val, time });
      this.value = val;
    }
    linearRampToValueAtTime(val, time) {
      this.calls.push({ method: "linearRampToValueAtTime", val, time });
      this.value = val;
    }
    exponentialRampToValueAtTime(val, time) {
      this.calls.push({ method: "exponentialRampToValueAtTime", val, time });
      this.value = val;
    }
  }

  class MockOscillatorNode {
    constructor() {
      this.type = "sine";
      this.frequency = new MockParam(440);
      this.connectedTo = null;
      this.startTime = null;
      this.stopTime = null;
      oscillators.push(this);
    }
    connect(target) {
      this.connectedTo = target;
    }
    start(time) {
      this.startTime = time;
    }
    stop(time) {
      this.stopTime = time;
    }
  }

  class MockGainNode {
    constructor() {
      this.gain = new MockParam(1);
      this.connectedTo = null;
      gains.push(this);
    }
    connect(target) {
      this.connectedTo = target;
    }
  }

  const mockContext = {
    state: initialState,
    currentTime: 10.0,
    destination: { name: "speaker" },
    resumeCount: 0,
    async resume() {
      this.resumeCount++;
      this.state = "running";
    },
    createOscillator() {
      return new MockOscillatorNode();
    },
    createGain() {
      return new MockGainNode();
    },
    oscillators,
    gains,
  };

  return mockContext;
}

test("playEarcon('start') synthesizes a gentle rising chirp ramp", async () => {
  const { playEarcon, setSoundEffectsOverride } = await load();
  setSoundEffectsOverride(true);

  const ctx = createMockAudioContext();
  const played = await playEarcon("start", { audioContext: ctx });

  assert.equal(played, true);
  assert.equal(ctx.oscillators.length, 1);
  assert.equal(ctx.gains.length, 1);

  const osc = ctx.oscillators[0];
  assert.equal(osc.type, "sine");
  // Frequency starts at 440 and ramps up to 880
  const freqSet = osc.frequency.calls.find((c) => c.method === "setValueAtTime");
  const freqRamp = osc.frequency.calls.find((c) => c.method === "exponentialRampToValueAtTime");
  assert.ok(freqSet, "frequency setValueAtTime called");
  assert.equal(freqSet.val, 440);
  assert.ok(freqRamp, "frequency exponentialRampToValueAtTime called");
  assert.equal(freqRamp.val, 880);
  assert.ok(freqRamp.val > freqSet.val, "frequency rises for start chirp");

  assert.equal(osc.startTime, 10.0);
  assert.ok(osc.stopTime > osc.startTime);
});

test("playEarcon('stop') synthesizes a soft descending chime ramp", async () => {
  const { playEarcon, setSoundEffectsOverride } = await load();
  setSoundEffectsOverride(true);

  const ctx = createMockAudioContext();
  const played = await playEarcon("stop", { audioContext: ctx });

  assert.equal(played, true);
  assert.equal(ctx.oscillators.length, 1);
  assert.equal(ctx.gains.length, 1);

  const osc = ctx.oscillators[0];
  assert.equal(osc.type, "sine");
  // Frequency starts at 660 and ramps down to 440
  const freqSet = osc.frequency.calls.find((c) => c.method === "setValueAtTime");
  const freqRamp = osc.frequency.calls.find((c) => c.method === "exponentialRampToValueAtTime");
  assert.ok(freqSet, "frequency setValueAtTime called");
  assert.equal(freqSet.val, 660);
  assert.ok(freqRamp, "frequency exponentialRampToValueAtTime called");
  assert.equal(freqRamp.val, 440);
  assert.ok(freqRamp.val < freqSet.val, "frequency descends for stop chime");
});

test("playEarcon('success') synthesizes a crisp warm confirmation ding", async () => {
  const { playEarcon, setSoundEffectsOverride } = await load();
  setSoundEffectsOverride(true);

  const ctx = createMockAudioContext();
  const played = await playEarcon("success", { audioContext: ctx });

  assert.equal(played, true);
  assert.equal(ctx.oscillators.length, 2, "2 tones synthesized for warm ding");
  assert.equal(ctx.gains.length, 2);

  const [osc1, osc2] = ctx.oscillators;
  assert.equal(osc1.type, "sine");
  assert.equal(osc2.type, "triangle");

  const freq1 = osc1.frequency.calls.find((c) => c.method === "setValueAtTime");
  const freq2 = osc2.frequency.calls.find((c) => c.method === "setValueAtTime");
  assert.equal(Math.round(freq1.val), 587); // D5
  assert.equal(Math.round(freq2.val), 880); // A5 (warm chime)
});

test("playEarcon('error') synthesizes a subtle soft low double-tone", async () => {
  const { playEarcon, setSoundEffectsOverride } = await load();
  setSoundEffectsOverride(true);

  const ctx = createMockAudioContext();
  const played = await playEarcon("error", { audioContext: ctx });

  assert.equal(played, true);
  assert.equal(ctx.oscillators.length, 2, "double-tone synthesized");
  assert.equal(ctx.gains.length, 2);

  const [osc1, osc2] = ctx.oscillators;
  assert.equal(osc1.type, "triangle");
  assert.equal(osc2.type, "triangle");

  const freq1 = osc1.frequency.calls.find((c) => c.method === "setValueAtTime");
  const freq2 = osc2.frequency.calls.find((c) => c.method === "setValueAtTime");
  assert.equal(freq1.val, 280);
  assert.equal(freq2.val, 220);
  assert.ok(osc2.startTime > osc1.startTime, "second tone fires after first tone");
});

test("playEarcon resumes a suspended AudioContext", async () => {
  const { playEarcon, setSoundEffectsOverride } = await load();
  setSoundEffectsOverride(true);

  const ctx = createMockAudioContext("suspended");
  assert.equal(ctx.state, "suspended");

  const played = await playEarcon("start", { audioContext: ctx });
  assert.equal(played, true);
  assert.equal(ctx.resumeCount, 1);
  assert.equal(ctx.state, "running");
});

test("playEarcon respects soundEffectsEnabled mute setting", async () => {
  const { playEarcon, setSoundEffectsOverride, isSoundEffectsEnabled } = await load();

  // Disabled
  setSoundEffectsOverride(false);
  assert.equal(isSoundEffectsEnabled(), false);

  const ctx = createMockAudioContext();
  const mutedResult = await playEarcon("start", { audioContext: ctx });
  assert.equal(mutedResult, false);
  assert.equal(ctx.oscillators.length, 0, "no sounds played when muted");

  // Force flag bypasses mute
  const forcedResult = await playEarcon("start", { audioContext: ctx, force: true });
  assert.equal(forcedResult, true);
  assert.equal(ctx.oscillators.length, 1);

  // Enabled
  setSoundEffectsOverride(true);
  assert.equal(isSoundEffectsEnabled(), true);
});

test("playEarcon safely falls back if AudioContext is unavailable", async () => {
  const { playEarcon, setSoundEffectsOverride } = await load();
  setSoundEffectsOverride(true);

  // Passing null context
  const played = await playEarcon("start", { audioContext: null });
  assert.equal(played, false, "gracefully returns false without throwing");
});

test("resolveModelIndicator correctly detects Fast Cloud vs Private Local", async () => {
  const { resolveModelIndicator } = await load();

  // 1. Explicit cloud provider
  const cloud1 = resolveModelIndicator({ activeModelProvider: "cloud" });
  assert.equal(cloud1.isCloud, true);
  assert.equal(cloud1.badgeText, "⚡ Fast Cloud");

  const cloud2 = resolveModelIndicator({ activeModelProvider: "openai" });
  assert.equal(cloud2.isCloud, true);
  assert.equal(cloud2.badgeText, "⚡ Fast Cloud");

  const cloud3 = resolveModelIndicator({ activeModelProvider: "anthropic" });
  assert.equal(cloud3.isCloud, true);
  assert.equal(cloud3.badgeText, "⚡ Fast Cloud");

  // 2. Explicit local provider
  const local1 = resolveModelIndicator({ activeModelProvider: "local" });
  assert.equal(local1.isCloud, false);
  assert.equal(local1.badgeText, "🔒 Private Local");

  const local2 = resolveModelIndicator({ activeModelProvider: "ollama" });
  assert.equal(local2.isCloud, false);
  assert.equal(local2.badgeText, "🔒 Private Local");

  const local3 = resolveModelIndicator({ activeModelProvider: "whisper" });
  assert.equal(local3.isCloud, false);
  assert.equal(local3.badgeText, "🔒 Private Local");

  // 3. Fallback to commandModeParser
  const parserCloud = resolveModelIndicator({ commandModeParser: "cloud" });
  assert.equal(parserCloud.isCloud, true);

  const parserLocal = resolveModelIndicator({ commandModeParser: "local" });
  assert.equal(parserLocal.isCloud, false);

  // 4. Fallback to dictation agent openwhispr mode
  const signedInOpenwhispr = resolveModelIndicator({
    dictationAgentMode: "openwhispr",
    isSignedIn: true,
  });
  assert.equal(signedInOpenwhispr.isCloud, true);

  // 5. Fallback to useLocalWhisper
  const cloudWhisper = resolveModelIndicator({ useLocalWhisper: false });
  assert.equal(cloudWhisper.isCloud, true);

  const localWhisper = resolveModelIndicator({ useLocalWhisper: true });
  assert.equal(localWhisper.isCloud, false);
  assert.equal(localWhisper.badgeText, "🔒 Private Local");
});

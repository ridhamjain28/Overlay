import {
  SILENCE_RMS_THRESHOLD,
  SPEECH_WINDOW_PEAK_THRESHOLD,
  SPEECH_WINDOW_RMS_THRESHOLD,
} from "./localSpeechGate.js";

// End-of-speech detection for dictation and assistant voice. Pure decision logic fed one mic
// level window at a time (RMS 0..~1, optional peak); the caller performs the
// actual stop/cancel. Nothing here touches the UI.
export const SILENCE_AUTO_STOP_DEFAULTS = Object.freeze({
  windowMs: 100,
  // Consecutive speech windows (3 x 100 ms = 300 ms minimum speech) required before speech counts as started, so
  // a cough, click or key tap does not arm the silence timer.
  speechStartWindows: 3,
  // Quiet time after speech that ends the question.
  silenceMs: 800,
  // Nothing said at all: give up quietly.
  noSpeechTimeoutMs: 8000,
  // Hard cap on one listen. The assistant hook passes 30 s; dictation keeps 60 s.
  maxRecordingMs: 60000,
});

export const ASSISTANT_MAX_RECORDING_MS = 30000;

export const createSilenceAutoStopState = (options = {}) => ({
  options: { ...SILENCE_AUTO_STOP_DEFAULTS, ...options },
  elapsedMs: 0,
  dataWindows: 0,
  noiseFloor: null,
  calibrateWindows: 0,
  calibrateMin: null,
  speechLevel: 0,
  consecutiveSpeechWindows: 0,
  speechStarted: false,
  quietMs: 0,
  decision: null,
});

// Highest ambient level we trust as "room noise" (byte-quantized RMS).
const NOISE_FLOOR_CAP = 0.05;
const NOISE_FLOOR_MIN = 0.0004;
const CALIBRATE_WINDOWS = 3;
const FLOOR_EMA_UP = 0.03;
const FLOOR_EMA_DOWN = 0.12;

const CONTINUE = Object.freeze({ action: "continue", reason: null });

const decide = (state, action, reason) => {
  state.decision = { action, reason };
  return state.decision;
};

const clampFloor = (value) =>
  Math.min(NOISE_FLOOR_CAP, Math.max(NOISE_FLOOR_MIN, value));

export const getSpeechThreshold = (state) =>
  Math.max(SPEECH_WINDOW_RMS_THRESHOLD, (state.noiseFloor ?? 0) * 2.5);

// Quiet means back near the room's noise floor, or well under the level the
// user was speaking at; whichever is higher, never below the gate's silence.
export const getQuietThreshold = (state) =>
  Math.max(SILENCE_RMS_THRESHOLD, (state.noiseFloor ?? 0) * 1.8, state.speechLevel * 0.2);

/**
 * Feed one analyser window. `rms` may be null when the analyser has no data
 * (suspended context); then only the time limits apply. `dtMs` defaults to the
 * configured window length.
 * Returns { action: "continue" | "stop" | "cancel", reason }.
 */
export const recordSilenceAutoStopWindow = (state, rms, peak = null, dtMs) => {
  if (!state) return CONTINUE;
  if (state.decision) return state.decision;
  const { options } = state;
  const step = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : options.windowMs;
  state.elapsedMs += step;

  if (Number.isFinite(rms) && rms >= 0) {
    state.dataWindows += 1;
    const peakOk = !Number.isFinite(peak) || peak >= SPEECH_WINDOW_PEAK_THRESHOLD;

    // Calibrate over the first ~300 ms from the quietest window so a user who
    // starts talking immediately is not mistaken for a loud room. Then keep a
    // slow EMA while the signal is below the speech threshold.
    if (state.calibrateWindows < CALIBRATE_WINDOWS) {
      state.calibrateWindows += 1;
      state.calibrateMin = state.calibrateMin === null ? rms : Math.min(state.calibrateMin, rms);
      if (state.calibrateWindows >= CALIBRATE_WINDOWS) {
        const min = state.calibrateMin;
        // Only ignore the calibration min when it is clearly speech, not a
        // merely noisy room (the 0.01 ambient fixture must remain the floor).
        state.noiseFloor = min >= 0.02 ? NOISE_FLOOR_MIN : clampFloor(min);
      } else if (state.noiseFloor === null) {
        state.noiseFloor = clampFloor(Math.min(rms, NOISE_FLOOR_CAP));
      }
    } else if (rms < getSpeechThreshold(state)) {
      const floor = state.noiseFloor ?? NOISE_FLOOR_MIN;
      const alpha = rms < floor ? FLOOR_EMA_DOWN : FLOOR_EMA_UP;
      state.noiseFloor = clampFloor(floor + (rms - floor) * alpha);
    }

    const isSpeech = rms >= getSpeechThreshold(state) && peakOk;

    if (isSpeech) {
      state.consecutiveSpeechWindows += 1;
      state.speechLevel =
        state.speechLevel === 0 ? rms : state.speechLevel + (rms - state.speechLevel) * 0.2;
      if (state.consecutiveSpeechWindows >= options.speechStartWindows) {
        state.speechStarted = true;
      }
    } else {
      state.consecutiveSpeechWindows = 0;
    }

    if (state.speechStarted) {
      if (!isSpeech && rms < getQuietThreshold(state)) {
        state.quietMs += step;
        if (state.quietMs >= options.silenceMs) return decide(state, "stop", "silence");
      } else {
        state.quietMs = 0;
      }
    }
  }

  if (state.elapsedMs >= options.maxRecordingMs) return decide(state, "stop", "max_duration");
  if (
    !state.speechStarted &&
    state.dataWindows > 0 &&
    state.elapsedMs >= options.noSpeechTimeoutMs
  ) {
    return decide(state, "cancel", "no_speech");
  }
  return CONTINUE;
};

// Hidden escape hatch (no UI): localStorage "overlayAssistantAutoStop" = "false".
export const isSilenceAutoStopEnabled = () => {
  try {
    return globalThis.localStorage?.getItem("overlayAssistantAutoStop") !== "false";
  } catch {
    return true;
  }
};

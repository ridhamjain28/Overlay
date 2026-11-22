import {
  SILENCE_RMS_THRESHOLD,
  SPEECH_WINDOW_PEAK_THRESHOLD,
  SPEECH_WINDOW_RMS_THRESHOLD,
} from "./localSpeechGate";

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
  // Hard cap on one assistant question.
  maxRecordingMs: 60000,
});

export const createSilenceAutoStopState = (options = {}) => ({
  options: { ...SILENCE_AUTO_STOP_DEFAULTS, ...options },
  elapsedMs: 0,
  dataWindows: 0,
  noiseFloor: null,
  speechLevel: 0,
  consecutiveSpeechWindows: 0,
  speechStarted: false,
  quietMs: 0,
  decision: null,
});

// Highest ambient level we trust as "room noise" (byte-quantized RMS).
const NOISE_FLOOR_CAP = 0.01;

const CONTINUE = Object.freeze({ action: "continue", reason: null });

const decide = (state, action, reason) => {
  state.decision = { action, reason };
  return state.decision;
};

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
    const isSpeech = rms >= getSpeechThreshold(state) && peakOk;

    if (!state.speechStarted) {
      // Track the ambient level before the user speaks: fall fast, rise slowly.
      // Capped, so a user who starts talking instantly can't be mistaken for
      // a loud room.
      if (state.noiseFloor === null || rms < state.noiseFloor) {
        state.noiseFloor = Math.min(rms, NOISE_FLOOR_CAP);
      } else if (!isSpeech) {
        state.noiseFloor = Math.min(
          NOISE_FLOOR_CAP,
          state.noiseFloor + (rms - state.noiseFloor) * 0.05
        );
      }
    }

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

/**
 * Overlay sound cues (Earcons) and model indicator helpers.
 * Synthesizes subtle, high-quality audio cues using the Web Audio API
 * with zero external asset dependencies.
 */

export type EarconType = "start" | "stop" | "success" | "error";

export interface PlayEarconOptions {
  audioContext?: AudioContext | null;
  force?: boolean;
}

export interface ModelIndicatorBadge {
  isCloud: boolean;
  label: "Fast Cloud" | "Private Local";
  badgeText: "⚡ Fast Cloud" | "🔒 Private Local";
}

let sharedAudioContext: AudioContext | null = null;
let _soundEffectsEnabledOverride: boolean | null = null;
let _settingsGetter: (() => boolean) | null = null;

/**
 * Override the sound effects setting (primarily for tests).
 */
export function setSoundEffectsOverride(enabled: boolean | null): void {
  _soundEffectsEnabledOverride = enabled;
}

/**
 * Register a getter function to check if sound effects are enabled in settingsStore.
 */
export function registerSoundEffectsEnabledGetter(getter: () => boolean): void {
  _settingsGetter = getter;
}

/**
 * Checks whether sound effects are currently enabled.
 * Defaults to true.
 */
export function isSoundEffectsEnabled(): boolean {
  if (_soundEffectsEnabledOverride !== null) {
    return _soundEffectsEnabledOverride;
  }
  if (_settingsGetter) {
    try {
      return _settingsGetter();
    } catch {
      // fallback
    }
  }
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage?.getItem("soundEffectsEnabled");
      if (stored !== null && stored !== undefined) {
        return stored !== "false";
      }
    } catch {
      // fallback
    }
  }
  return true;
}

/**
 * Lazily get or create the Web Audio API AudioContext.
 */
export function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined" && typeof (globalThis as any).AudioContext === "undefined") {
    return null;
  }
  const Ctor =
    (typeof window !== "undefined" && (window.AudioContext || (window as any).webkitAudioContext)) ||
    (globalThis as any).AudioContext;

  if (!Ctor) return null;

  if (!sharedAudioContext || (sharedAudioContext as any).state === "closed") {
    try {
      sharedAudioContext = new Ctor();
    } catch {
      return null;
    }
  }
  return sharedAudioContext;
}

/**
 * Set an explicit AudioContext (useful for mocking in unit tests).
 */
export function setAudioContextForTesting(ctx: AudioContext | null): void {
  sharedAudioContext = ctx;
}

/**
 * Gentle rising chirp: 440 Hz -> 880 Hz sine wave ramp (listening).
 */
function synthesizeStart(ctx: AudioContext, now: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(440, now);
  if (typeof osc.frequency.exponentialRampToValueAtTime === "function") {
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
  } else {
    osc.frequency.setValueAtTime(880, now + 0.12);
  }

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.1, now + 0.015);
  if (typeof gain.gain.exponentialRampToValueAtTime === "function") {
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  } else {
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.12);
  }

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.13);
}

/**
 * Soft gentle descending chime: 660 Hz -> 440 Hz sine wave ramp (processing).
 */
function synthesizeStop(ctx: AudioContext, now: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(660, now);
  if (typeof osc.frequency.exponentialRampToValueAtTime === "function") {
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.14);
  } else {
    osc.frequency.setValueAtTime(440, now + 0.14);
  }

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.09, now + 0.015);
  if (typeof gain.gain.exponentialRampToValueAtTime === "function") {
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  } else {
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.14);
  }

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.15);
}

/**
 * Crisp warm confirmation ding: warm 2-tone chime (action succeeded).
 */
function synthesizeSuccess(ctx: AudioContext, now: number): void {
  // Grace tone: 587.33 Hz (D5)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(587.33, now);

  gain1.gain.setValueAtTime(0.0001, now);
  gain1.gain.linearRampToValueAtTime(0.08, now + 0.01);
  if (typeof gain1.gain.exponentialRampToValueAtTime === "function") {
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  } else {
    gain1.gain.linearRampToValueAtTime(0.0001, now + 0.08);
  }

  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.09);

  // Main resonant chime: 880 Hz (A5)
  const t2 = now + 0.06;
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "triangle";
  osc2.frequency.setValueAtTime(880, t2);

  gain2.gain.setValueAtTime(0.0001, t2);
  gain2.gain.linearRampToValueAtTime(0.12, t2 + 0.015);
  if (typeof gain2.gain.exponentialRampToValueAtTime === "function") {
    gain2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.22);
  } else {
    gain2.gain.linearRampToValueAtTime(0.0001, t2 + 0.22);
  }

  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(t2);
  osc2.stop(t2 + 0.23);
}

/**
 * Subtle soft low double-tone: 280 Hz then 220 Hz triangle waves (action failed / blocked).
 */
function synthesizeError(ctx: AudioContext, now: number): void {
  // First pulse: 280 Hz
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "triangle";
  osc1.frequency.setValueAtTime(280, now);

  gain1.gain.setValueAtTime(0.0001, now);
  gain1.gain.linearRampToValueAtTime(0.09, now + 0.01);
  if (typeof gain1.gain.exponentialRampToValueAtTime === "function") {
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
  } else {
    gain1.gain.linearRampToValueAtTime(0.0001, now + 0.07);
  }

  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.075);

  // Second pulse: 220 Hz
  const t2 = now + 0.09;
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "triangle";
  osc2.frequency.setValueAtTime(220, t2);

  gain2.gain.setValueAtTime(0.0001, t2);
  gain2.gain.linearRampToValueAtTime(0.09, t2 + 0.01);
  if (typeof gain2.gain.exponentialRampToValueAtTime === "function") {
    gain2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.08);
  } else {
    gain2.gain.linearRampToValueAtTime(0.0001, t2 + 0.08);
  }

  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(t2);
  osc2.stop(t2 + 0.085);
}

/**
 * Plays the requested earcon sound effect using Web Audio API synthesis.
 * Safe fallback to no-op if AudioContext is unavailable or sound effects are disabled.
 */
export async function playEarcon(
  type: EarconType,
  options: PlayEarconOptions = {}
): Promise<boolean> {
  if (!options.force && !isSoundEffectsEnabled()) {
    return false;
  }

  const ctx = options.audioContext !== undefined ? options.audioContext : getAudioContext();
  if (!ctx) {
    return false;
  }

  try {
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      await ctx.resume();
    }
  } catch {
    // ignore resume errors
  }

  try {
    const now = ctx.currentTime || 0;
    switch (type) {
      case "start":
        synthesizeStart(ctx, now);
        break;
      case "stop":
        synthesizeStop(ctx, now);
        break;
      case "success":
        synthesizeSuccess(ctx, now);
        break;
      case "error":
        synthesizeError(ctx, now);
        break;
      default:
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the visual status badge (⚡ Fast Cloud vs 🔒 Private Local)
 * based on current active model provider or local/cloud settings.
 */
export function resolveModelIndicator(options: {
  activeModelProvider?: string | null;
  commandModeParser?: string | null;
  useLocalWhisper?: boolean | null;
  dictationAgentMode?: string | null;
  isSignedIn?: boolean | null;
}): ModelIndicatorBadge {
  const {
    activeModelProvider,
    commandModeParser,
    useLocalWhisper,
    dictationAgentMode,
    isSignedIn,
  } = options;

  let isCloud = false;

  if (activeModelProvider) {
    const p = activeModelProvider.toLowerCase().trim();
    if (
      p === "cloud" ||
      p === "openai" ||
      p === "anthropic" ||
      p === "groq" ||
      p === "openrouter" ||
      p.includes("cloud")
    ) {
      isCloud = true;
    } else if (
      p === "local" ||
      p === "ollama" ||
      p === "whisper" ||
      p.includes("local")
    ) {
      isCloud = false;
    } else {
      isCloud = false;
    }
  } else if (commandModeParser === "cloud") {
    isCloud = true;
  } else if (commandModeParser === "local") {
    isCloud = false;
  } else if (dictationAgentMode === "openwhispr" && isSignedIn) {
    isCloud = true;
  } else if (useLocalWhisper === false) {
    isCloud = true;
  } else {
    isCloud = false;
  }

  return {
    isCloud,
    label: isCloud ? "Fast Cloud" : "Private Local",
    badgeText: isCloud ? "⚡ Fast Cloud" : "🔒 Private Local",
  };
}

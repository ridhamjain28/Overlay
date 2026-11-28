// Plays assistant replies via built-in OS speechSynthesis (free, offline) or
// main-process Inworld audio. The renderer never sees the Inworld API key:
// it only sends text and receives audio bytes.

import { useSettingsStore } from "../stores/settingsStore";

export interface TtsSpeakingState {
  speaking: boolean;
  messageId?: string;
}

type TtsSubscriber = (state: TtsSpeakingState) => void;

let playbackGeneration = 0;
let currentAudio: HTMLAudioElement | null = null;
let speakingState: TtsSpeakingState = { speaking: false };
const subscribers = new Set<TtsSubscriber>();

function notifySpeaking(next: TtsSpeakingState): void {
  speakingState = next;
  for (const cb of subscribers) {
    try {
      cb(next);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function getTtsSpeakingState(): TtsSpeakingState {
  return speakingState;
}

export function subscribeTtsSpeaking(cb: TtsSubscriber): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function speechText(text: string): string {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\](\([^)]+\))/g, "$1")
    .replace(/[#*_>~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stopAssistantTts(): void {
  playbackGeneration += 1;
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.removeAttribute("src");
      currentAudio.load();
    } catch {
      // Playback is best-effort; a leftover element must not break the next turn.
    }
    currentAudio = null;
  }
  if (speakingState.speaking) {
    notifySpeaking({ speaking: false });
  }
}

function playDataUri(uri: string, generation: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (generation !== playbackGeneration) {
      resolve();
      return;
    }
    const audio = new Audio(uri);
    currentAudio = audio;
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onerror = () => {
      if (currentAudio === audio) currentAudio = null;
      reject(new Error("audio_playback_failed"));
    };
    void audio.play().catch(reject);
  });
}

function speakViaSystemTts(
  spoken: string,
  generation: number,
  messageId?: string
): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    const synth = window.speechSynthesis;
    try {
      synth.cancel();
    } catch {
      // ignore
    }
    if (generation !== playbackGeneration) {
      resolve();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(spoken);
    const settings = useSettingsStore.getState();
    const rate = Number(settings.systemTtsRate);
    utterance.rate = Number.isFinite(rate) && rate >= 0.6 && rate <= 1.8 ? rate : 1;

    if (settings.systemTtsVoice) {
      const voices = synth.getVoices?.() ?? [];
      const match = voices.find((v) => v.name === settings.systemTtsVoice);
      if (match) utterance.voice = match;
    }

    notifySpeaking({ speaking: true, messageId });

    const finish = () => {
      if (generation === playbackGeneration) {
        notifySpeaking({ speaking: false });
      }
      resolve();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    try {
      synth.speak(utterance);
    } catch {
      finish();
    }
  });
}

async function speakViaInworld(
  spoken: string,
  generation: number,
  messageId?: string
): Promise<void> {
  if (typeof window === "undefined" || !window.electronAPI?.inworldSynthesize) return;

  const settings = useSettingsStore.getState();
  const result = await window.electronAPI.inworldSynthesize({
    text: spoken,
    voiceId: settings.inworldVoiceId,
  });
  if (generation !== playbackGeneration) return;
  if (!result?.success) return;

  const parts =
    Array.isArray(result.audioBase64Parts) && result.audioBase64Parts.length > 0
      ? result.audioBase64Parts
      : result.audioBase64
        ? [result.audioBase64]
        : [];
  const mimeType = result.mimeType || "audio/mpeg";

  notifySpeaking({ speaking: true, messageId });
  try {
    for (const part of parts) {
      if (generation !== playbackGeneration) return;
      if (typeof part !== "string" || !part) continue;
      try {
        await playDataUri(`data:${mimeType};base64,${part}`, generation);
      } catch {
        return;
      }
    }
  } finally {
    if (generation === playbackGeneration) {
      notifySpeaking({ speaking: false });
    }
  }
}

/**
 * Speaks an assistant reply automatically if TTS is enabled in settings.
 */
export async function maybeSpeakAssistantReply(text: string): Promise<void> {
  const settings = useSettingsStore.getState();
  if (settings.assistantTtsProvider === "off") return;

  const spoken = speechText(text);
  if (!spoken) return;

  const generation = ++playbackGeneration;
  if (settings.assistantTtsProvider === "system") {
    await speakViaSystemTts(spoken, generation);
    return;
  }
  await speakViaInworld(spoken, generation);
}

/**
 * Manually reads aloud any text (used by Read Aloud buttons). Uses Inworld if
 * selected, otherwise falls back to built-in OS speechSynthesis.
 */
export async function speakAssistantText(
  text: string,
  opts?: { messageId?: string }
): Promise<void> {
  const spoken = speechText(text);
  if (!spoken) return;

  stopAssistantTts();
  const generation = ++playbackGeneration;
  const settings = useSettingsStore.getState();

  if (settings.assistantTtsProvider === "inworld") {
    await speakViaInworld(spoken, generation, opts?.messageId);
    return;
  }
  await speakViaSystemTts(spoken, generation, opts?.messageId);
}

/**
 * Plays a short synthesized earcon tone for command feedback.
 */
export function playEarcon(type: "success" | "error" | "start"): void {
  if (typeof window === "undefined") return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const tones: Array<[number, number, number]> =
      type === "success"
        ? [
            [220, 0, 0.08],
            [440, 0.08, 0.08],
          ]
        : type === "error"
          ? [
              [440, 0, 0.08],
              [220, 0.08, 0.08],
            ]
          : [[330, 0, 0.06]];

    for (const [freq, offset, dur] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + offset);
      gain.gain.setValueAtTime(0.08, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + dur);
    }

    const totalMs = type === "start" ? 100 : 200;
    setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, totalMs);
  } catch {
    // AudioContext may be blocked or unavailable in headless environments.
  }
}

export { speechText };

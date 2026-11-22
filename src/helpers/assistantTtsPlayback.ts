// Plays assistant replies from main-process Inworld audio. The renderer never
// sees the API key: it only sends text and receives audio bytes.

import { useSettingsStore } from "../stores/settingsStore";

let playbackGeneration = 0;
let currentAudio: HTMLAudioElement | null = null;

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
  if (!currentAudio) return;
  try {
    currentAudio.pause();
    currentAudio.removeAttribute("src");
    currentAudio.load();
  } catch {
    // Playback is best-effort; a leftover element must not break the next turn.
  }
  currentAudio = null;
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

export async function maybeSpeakAssistantReply(text: string): Promise<void> {
  const settings = useSettingsStore.getState();
  if (settings.assistantTtsProvider !== "inworld") return;

  const spoken = speechText(text);
  if (!spoken) return;
  if (typeof window === "undefined" || !window.electronAPI?.inworldSynthesize) return;

  const generation = ++playbackGeneration;
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      // ignore
    }
    currentAudio = null;
  }

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

  for (const part of parts) {
    if (generation !== playbackGeneration) return;
    if (typeof part !== "string" || !part) continue;
    try {
      await playDataUri(`data:${mimeType};base64,${part}`, generation);
    } catch {
      return;
    }
  }
}

export { speechText };

// Inworld TTS lives in the main process only. The API key is read here from
// environment/secure storage and is never returned over IPC, logged, or sent
// to a renderer. Docs: https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech

const DEFAULT_VOICES = [
  {
    voiceId: "Ashley",
    displayName: "Ashley",
    description: "A warm, natural female voice",
  },
  {
    voiceId: "Dennis",
    displayName: "Dennis",
    description: "Middle-aged man with a smooth, calm and friendly voice",
  },
  {
    voiceId: "Alex",
    displayName: "Alex",
    description: "Energetic and expressive mid-range male voice",
  },
];

const SYNTHESIZE_URL = "https://api.inworld.ai/tts/v1/voice";
const VOICES_URL = "https://api.inworld.ai/tts/v1/voices?filter=language%3Den";
const DEFAULT_MODEL_ID = "inworld-tts-2";
const DEFAULT_VOICE_ID = "Ashley";
const MAX_TEXT_UNITS = 2000;
const REQUEST_TIMEOUT_MS = 30000;

function looksLikePlaceholder(value) {
  return !value || /^your_/i.test(value);
}

function readKey(getKey) {
  const raw = typeof getKey === "function" ? getKey() : "";
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key || looksLikePlaceholder(key)) return "";
  return key;
}

function hasKey(getKey) {
  return readKey(getKey).length > 0;
}

function redact(text, key) {
  if (typeof text !== "string" || !key) return typeof text === "string" ? text : "";
  return text.includes(key) ? text.split(key).join("[redacted]") : text;
}

function safeErrorMessage(error, key) {
  const message = error?.message || String(error || "Inworld TTS request failed");
  return redact(message, key);
}

function splitText(text) {
  const input = String(text || "").trim();
  if (!input) return [];
  if (input.length <= MAX_TEXT_UNITS) return [input];

  const chunks = [];
  let remaining = input;
  while (remaining.length > MAX_TEXT_UNITS) {
    const window = remaining.slice(0, MAX_TEXT_UNITS);
    const breakAt = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! ")
    );
    const end = breakAt >= 200 ? breakAt + 1 : MAX_TEXT_UNITS;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function parseFailedResponse(response, key) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  let message = `Inworld TTS failed (${response.status})`;
  try {
    const json = JSON.parse(body);
    if (json && typeof json.message === "string" && json.message.trim()) {
      message = json.message.trim();
    }
  } catch {
    // Leave the status-only message. Never attach the raw body: it might echo
    // request headers.
  }
  return { success: false, error: redact(message, key), status: response.status };
}

function createInworldTts({ getKey, fetchImpl, logger } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const log = logger || { warn() {}, debug() {} };

  async function authorizedFetch(url, options = {}) {
    const key = readKey(getKey);
    if (!key) return { success: false, error: "not_configured" };
    if (typeof fetchFn !== "function") {
      return { success: false, error: "Inworld TTS is unavailable in this build" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(url, {
        ...options.request,
        headers: {
          Authorization: `Basic ${key}`,
          "Content-Type": "application/json",
          ...(options.request?.headers || {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) return parseFailedResponse(response, key);
      return { success: true, response, key };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { success: false, error: "Inworld TTS timed out" };
      }
      log.warn("Inworld TTS request failed", { error: safeErrorMessage(error, key) }, "inworld");
      return { success: false, error: "Inworld TTS request failed" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function synthesize({ text, voiceId, modelId } = {}) {
    const chunks = splitText(text);
    if (chunks.length === 0) return { success: false, error: "empty_text" };
    if (!readKey(getKey)) return { success: false, error: "not_configured" };

    const audioParts = [];
    const voice = voiceId && String(voiceId).trim() ? String(voiceId).trim() : DEFAULT_VOICE_ID;
    const model = modelId && String(modelId).trim() ? String(modelId).trim() : DEFAULT_MODEL_ID;

    for (const chunk of chunks) {
      const result = await authorizedFetch(SYNTHESIZE_URL, {
        request: {
          method: "POST",
          body: JSON.stringify({
            text: chunk,
            voiceId: voice,
            modelId: model,
            audioConfig: { audioEncoding: "MP3" },
          }),
        },
      });
      if (!result.success) return { success: false, error: result.error, status: result.status };

      let payload;
      try {
        payload = await result.response.json();
      } catch {
        return { success: false, error: "Inworld TTS returned an unreadable response" };
      }
      const audioContent = typeof payload?.audioContent === "string" ? payload.audioContent : "";
      if (!audioContent) return { success: false, error: "Inworld TTS returned no audio" };
      audioParts.push(audioContent);
    }

    // One short reply is a single MP3. Longer replies are spoken as sequential
    // MP3s so we never concatenate frames (that produces clicks).
    return {
      success: true,
      audioBase64Parts: audioParts,
      mimeType: "audio/mpeg",
      voiceId: voice,
      modelId: model,
    };
  }

  async function listVoices() {
    if (!readKey(getKey)) return { success: true, voices: DEFAULT_VOICES, source: "default" };

    const result = await authorizedFetch(VOICES_URL, { request: { method: "GET" } });
    if (!result.success) return { success: true, voices: DEFAULT_VOICES, source: "default" };

    try {
      const payload = await result.response.json();
      const voices = Array.isArray(payload?.voices)
        ? payload.voices
            .map((voice) => ({
              voiceId: String(voice.voiceId || "").trim(),
              displayName: String(voice.displayName || voice.voiceId || "").trim(),
              description: String(voice.description || "").trim(),
            }))
            .filter((voice) => voice.voiceId)
        : [];
      if (voices.length === 0) return { success: true, voices: DEFAULT_VOICES, source: "default" };
      return { success: true, voices, source: "inworld" };
    } catch {
      return { success: true, voices: DEFAULT_VOICES, source: "default" };
    }
  }

  return { hasKey: () => hasKey(getKey), synthesize, listVoices };
}

module.exports = {
  DEFAULT_VOICES,
  DEFAULT_VOICE_ID,
  DEFAULT_MODEL_ID,
  SYNTHESIZE_URL,
  VOICES_URL,
  createInworldTts,
  hasKey,
  splitText,
};

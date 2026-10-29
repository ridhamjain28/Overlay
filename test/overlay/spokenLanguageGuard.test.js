const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("../helpers/harness/audioManager");

async function loadGuard() {
  const mod = await import("../../src/helpers/overlay/spokenLanguageGuard.js");
  return mod.singleSpokenLanguage ? mod : mod.default;
}

const HINDI = "मैं कल ऑफिस जाऊंगा और रिपोर्ट भेजूंगा";
const URDU = "میں کل آفس جاؤں گا اور رپورٹ بھیجوں گا";
const ENGLISH = "I will go to the office tomorrow and send the report";
const HINGLISH = "main kal office jaunga aur report bhejunga";

test("one spoken language pins transcription; an explicit choice or translation wins", async () => {
  const g = await loadGuard();
  assert.equal(
    g.singleSpokenLanguage({ preferredLanguage: "auto", spokenLanguages: ["fr"] }),
    "fr"
  );
  assert.equal(g.singleSpokenLanguage({ spokenLanguages: ["en-US", "en-GB"] }), "en-US");
  assert.equal(g.singleSpokenLanguage({ preferredLanguage: "de", spokenLanguages: ["fr"] }), null);
  assert.equal(
    g.singleSpokenLanguage({ spokenLanguages: ["fr"] }, { translationRequested: true }),
    null
  );
  assert.equal(g.singleSpokenLanguage({ spokenLanguages: ["en", "hi"] }), null);
  assert.equal(g.singleSpokenLanguage({ spokenLanguages: [] }), null);
  assert.equal(g.singleSpokenLanguage({}), null);
});

test("scripts: Hindi plus Hinglish plus English allows Devanagari and Latin only", async () => {
  const g = await loadGuard();
  const scripts = g.allowedScripts({ spokenLanguages: ["en-US", "hi-Latn", "hi"] });
  assert.deepEqual([...scripts].sort(), ["Devanagari", "Latin"]);
  assert.equal(g.violatesSpokenLanguages(HINDI, scripts), false);
  assert.equal(g.violatesSpokenLanguages(ENGLISH, scripts), false);
  assert.equal(g.violatesSpokenLanguages(HINGLISH, scripts), false);
  assert.equal(g.violatesSpokenLanguages(URDU, scripts), true);
  // A stray foreign word or too little text is not a violation.
  assert.equal(g.violatesSpokenLanguages("ok so the meeting is at میں", scripts), false);
  assert.equal(g.violatesSpokenLanguages("میں", scripts), false);
  assert.equal(g.violatesSpokenLanguages("", scripts), false);
});

test("no guard for one language, an unknown script, or an explicit language", async () => {
  const g = await loadGuard();
  assert.equal(g.createSpokenLanguageGuard({ spokenLanguages: ["en"] }), null);
  assert.equal(g.createSpokenLanguageGuard({ spokenLanguages: ["en", "xx"] }), null);
  assert.equal(
    g.createSpokenLanguageGuard({ preferredLanguage: "hi", spokenLanguages: ["en", "hi"] }),
    null
  );
  assert.equal(
    g.createSpokenLanguageGuard({ spokenLanguages: ["en", "hi"] }, { translationRequested: true }),
    null
  );
});

test("the retry language follows the script that was heard", async () => {
  const g = await loadGuard();
  const settings = { spokenLanguages: ["en-US", "hi-Latn", "hi"] };
  assert.equal(g.pickRetryLanguage(URDU, settings), "hi");
  assert.equal(g.pickRetryLanguage("Привет как дела сегодня", settings), "hi");
  assert.equal(g.pickRetryLanguage("Привет как дела", { spokenLanguages: ["en", "es"] }), "en");
  assert.equal(g.pickRetryLanguage("hello there", { spokenLanguages: ["ja", "hi"] }), "ja");
  const guard = g.createSpokenLanguageGuard(settings);
  assert.equal(guard.check(URDU, "hinglish"), false, "the Hinglish server is never second-guessed");
  assert.equal(guard.check(ENGLISH, "openai"), false);
  assert.equal(guard.check(URDU, "openai"), true);
  assert.equal(guard.retryLanguage, "hi");
  assert.equal(guard.check(URDU, "openai"), false, "only one retry");
});

async function runDictation(t, { settings, respond }) {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "overlay-spoken-language-guard-",
    settingsKey: "__spokenLanguageGuardSettings",
    settings: {
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
      cloudTranscriptionModel: "whisper-1",
      allowLocalFallback: false,
      dataRetentionEnabled: false,
      ...settings,
    },
  });
  window.electronAPI = { saveTranscription: async () => ({ id: 1 }) };
  const languages = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const language = init?.body?.get?.("language") ?? null;
    languages.push(language);
    return new Response(JSON.stringify({ text: respond(language) }), { status: 200 });
  });
  const audio = new Blob(["synthetic audio"], { type: "audio/webm" });
  const results = [];
  const errors = [];
  const manager = createManager({
    isProcessing: true,
    lastAudioBlob: audio,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _localSpeechGateState: null,
    getTranscriptionModel: () => "whisper-1",
    getAPIKey: async () => "test-key",
    getTranscriptionEndpoint: () => "https://stt.example.com/v1/audio/transcriptions",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    onStateChange() {},
    onTranscriptionComplete: (result) => results.push(result),
    onError: (error) => errors.push(error),
  });
  await manager.processAudio(audio);
  return { manager, languages, results, errors };
}

test("an Urdu-script transcript for a Hindi and English speaker is redone in Hindi", async (t) => {
  const { manager, languages, results, errors } = await runDictation(t, {
    settings: { preferredLanguage: "auto", spokenLanguages: ["en-US", "hi"] },
    respond: (language) => (language === "hi" ? HINDI : URDU),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(languages, [null, "hi"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, HINDI);
  assert.equal(manager._sttLanguageOverride, null, "the pin ends with the recording");
  assert.equal(manager._spokenLanguageGuard, null);
});

test("an allowed transcript is transcribed once, exactly as before", async (t) => {
  const { languages, results } = await runDictation(t, {
    settings: { preferredLanguage: "auto", spokenLanguages: ["en-US", "hi"] },
    respond: () => ENGLISH,
  });
  assert.deepEqual(languages, [null]);
  assert.equal(results[0].text, ENGLISH);
});

test("a single spoken language is sent as the transcription language", async (t) => {
  const { languages } = await runDictation(t, {
    settings: { preferredLanguage: "auto", spokenLanguages: ["fr"] },
    respond: () => "Bonjour tout le monde",
  });
  assert.deepEqual(languages, ["fr"]);
});

test("without spoken languages nothing changes", async (t) => {
  const { languages, results } = await runDictation(t, {
    settings: { preferredLanguage: "auto" },
    respond: () => URDU,
  });
  assert.deepEqual(languages, [null]);
  assert.equal(results[0].text, URDU);
});

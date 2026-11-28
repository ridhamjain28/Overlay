const test = require("node:test");
const assert = require("node:assert/strict");

test("assistantTtsPlayback: speechText strips markdown and speaks via system TTS", async () => {
  const spoken = [];
  let cancelled = 0;

  globalThis.window = {
    speechSynthesis: {
      cancel: () => {
        cancelled += 1;
      },
      speak: (utterance) => {
        spoken.push({ text: utterance.text, rate: utterance.rate, voice: utterance.voice?.name });
        utterance.onend?.();
      },
      getVoices: () => [{ name: "TestVoice", lang: "en-US" }],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
      this.rate = 1;
      this.voice = null;
    }
  };

  const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
  useSettingsStore.getState().setAssistantTtsProvider("system");
  useSettingsStore.getState().setSystemTtsVoice("TestVoice");
  useSettingsStore.getState().setSystemTtsRate(1.3);

  const { maybeSpeakAssistantReply, speakAssistantText, stopAssistantTts } = await import(
    "../../src/helpers/assistantTtsPlayback.ts"
  );

  await maybeSpeakAssistantReply("**Hello** `world` [link](https://example.com)");
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "Hello world link");
  assert.equal(spoken[0].rate, 1.3);
  assert.equal(spoken[0].voice, "TestVoice");

  await speakAssistantText("Manual read", { messageId: "m1" });
  assert.equal(spoken.length, 2);

  stopAssistantTts();
  assert.ok(cancelled >= 2);
});

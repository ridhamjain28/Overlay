const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Overlay must start local-first on a brand-new profile, and its local model
// must survive the upstream "retired cloud model" startup migrations.
test("a fresh Overlay profile starts on local Whisper and local Ollama", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _overlayDefaultsApplied: undefined },
  });
  const vite = await createRendererServer(t, { cachePrefix: "overlay-first-run-test-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const s = useSettingsStore.getState();

  assert.equal(s.transcriptionMode, "local");
  assert.equal(s.useLocalWhisper, true);
  for (const prefix of [
    "cleanup",
    "chatAgent",
    "dictationAgent",
    "noteFormatting",
    "translation",
  ]) {
    assert.equal(s[`${prefix}Mode`], "self-hosted", prefix);
    assert.equal(s[`${prefix}RemoteUrl`], "http://localhost:11434/v1", prefix);
    assert.equal(s[`${prefix}Model`], "qwen3.5:4b-q4_K_M", prefix);
  }
  assert.equal(s.answerSource, "auto");
  assert.equal(storage.getItem("_overlayDefaultsApplied"), "1");
});

test("an existing profile is never overwritten by the first-run defaults", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _overlayDefaultsApplied: undefined,
      _llmScopeKeysMigrated: "1",
      chatAgentMode: "providers",
      chatAgentProvider: "openai",
      chatAgentModel: "gpt-5.2",
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "overlay-first-run-existing-test-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const s = useSettingsStore.getState();
  assert.equal(s.chatAgentMode, "providers");
  assert.equal(s.chatAgentProvider, "openai");
});

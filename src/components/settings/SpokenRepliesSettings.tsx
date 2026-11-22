import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useSettingsStore } from "../../stores/settingsStore";
import { maybeSpeakAssistantReply, stopAssistantTts } from "../../helpers/assistantTtsPlayback";
import logger from "../../utils/logger";

interface InworldVoiceOption {
  voiceId: string;
  displayName: string;
  description?: string;
}

const FALLBACK_VOICES: InworldVoiceOption[] = [
  { voiceId: "Ashley", displayName: "Ashley", description: "A warm, natural female voice" },
  { voiceId: "Dennis", displayName: "Dennis", description: "Calm, friendly male voice" },
  { voiceId: "Alex", displayName: "Alex", description: "Energetic, expressive male voice" },
];

/**
 * "toggle": only the on/off row (main Settings). "config": voice, key and test
 * without the toggle (Advanced). "all": both.
 */
export default function SpokenRepliesSettings({
  mode = "all",
}: {
  mode?: "toggle" | "config" | "all";
}) {
  const { t } = useTranslation();
  const assistantTtsProvider = useSettingsStore((state) => state.assistantTtsProvider);
  const setAssistantTtsProvider = useSettingsStore((state) => state.setAssistantTtsProvider);
  const inworldVoiceId = useSettingsStore((state) => state.inworldVoiceId);
  const setInworldVoiceId = useSettingsStore((state) => state.setInworldVoiceId);

  const enabled = assistantTtsProvider === "inworld";
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [voices, setVoices] = useState<InworldVoiceOption[]>(FALLBACK_VOICES);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState(false);

  const refreshKeyState = useCallback(async () => {
    if (!window.electronAPI?.inworldHasKey) {
      setHasKey(false);
      return;
    }
    try {
      const state = await window.electronAPI.inworldHasKey();
      setHasKey(!!state?.hasKey);
    } catch (error) {
      logger.error("Failed to read Inworld key state", error, "settings");
      setHasKey(false);
    }
  }, []);

  const refreshVoices = useCallback(async () => {
    if (!window.electronAPI?.inworldListVoices) return;
    try {
      const result = await window.electronAPI.inworldListVoices();
      if (result?.success && Array.isArray(result.voices) && result.voices.length > 0) {
        setVoices(result.voices);
      }
    } catch (error) {
      logger.error("Failed to list Inworld voices", error, "settings");
    }
  }, []);

  useEffect(() => {
    void refreshKeyState();
    void refreshVoices();
  }, [refreshKeyState, refreshVoices]);

  const handleSaveKey = async () => {
    if (!window.electronAPI?.inworldSaveKey || !keyDraft.trim()) return;
    setSaving(true);
    try {
      await window.electronAPI.inworldSaveKey(keyDraft.trim());
      setKeyDraft("");
      await refreshKeyState();
      await refreshVoices();
    } catch (error) {
      logger.error("Failed to save Inworld key", error, "settings");
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (!window.electronAPI?.inworldClearKey) return;
    setSaving(true);
    try {
      await window.electronAPI.inworldClearKey();
      setKeyDraft("");
      await refreshKeyState();
    } catch (error) {
      logger.error("Failed to clear Inworld key", error, "settings");
    } finally {
      setSaving(false);
    }
  };

  const handleTestVoice = async () => {
    setTesting(true);
    setTestError(false);
    try {
      stopAssistantTts();
      await maybeSpeakAssistantReply(t("settingsPage.general.spokenReplies.testPhrase"));
    } catch {
      setTestError(true);
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsPanel>
      {mode !== "config" && (
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.general.spokenReplies.enabled")}
            description={t("settingsPage.general.spokenReplies.enabledDescription")}
          >
            <Toggle
              checked={enabled}
              onChange={(checked: boolean) => setAssistantTtsProvider(checked ? "inworld" : "off")}
            />
          </SettingsRow>
        </SettingsPanelRow>
      )}
      {mode !== "toggle" && (mode === "config" || enabled) && (
        <>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.general.spokenReplies.provider")}
              description={t("settingsPage.general.spokenReplies.providerDescription")}
            >
              <Select value="inworld" onValueChange={() => undefined}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inworld">
                    {t("settingsPage.general.spokenReplies.providerInworld")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.general.spokenReplies.voice")}
              description={t("settingsPage.general.spokenReplies.voiceDescription")}
            >
              <Select value={inworldVoiceId} onValueChange={setInworldVoiceId}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((voice) => (
                    <SelectItem key={voice.voiceId} value={voice.voiceId}>
                      {voice.displayName || voice.voiceId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <div className="flex w-full flex-col gap-2">
              <SettingsRow
                label={t("settingsPage.general.spokenReplies.apiKey")}
                description={t("settingsPage.general.spokenReplies.apiKeyDescription")}
              >
                <div className="flex min-w-[260px] flex-col items-end gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder={
                      hasKey
                        ? t("settingsPage.general.spokenReplies.apiKeySet")
                        : t("settingsPage.general.spokenReplies.apiKeyPlaceholder")
                    }
                    className="w-[220px]"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving || !keyDraft.trim()}
                      onClick={() => void handleSaveKey()}
                    >
                      {t("settingsPage.general.spokenReplies.apiKeySave")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving || !hasKey}
                      onClick={() => void handleClearKey()}
                    >
                      {t("settingsPage.general.spokenReplies.apiKeyClear")}
                    </Button>
                  </div>
                </div>
              </SettingsRow>
              <p className="text-xs text-muted-foreground">
                {t("settingsPage.general.spokenReplies.apiKeyHelp")}
              </p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testing || !hasKey}
                  onClick={() => void handleTestVoice()}
                >
                  {t("settingsPage.general.spokenReplies.test")}
                </Button>
                {testError && (
                  <p className="mt-2 text-xs text-destructive">
                    {t("settingsPage.general.spokenReplies.testFailed")}
                  </p>
                )}
              </div>
            </div>
          </SettingsPanelRow>
        </>
      )}
    </SettingsPanel>
  );
}

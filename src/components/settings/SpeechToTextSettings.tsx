import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Key, Network } from "../icons";
import {
  InferenceModeSelector,
  SectionHeader,
  SettingsPanel,
  SettingsPanelRow,
  SettingsRow,
} from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import { useSettings } from "../../hooks/useSettings";
import { getTranscriptionProvider } from "../../models/ModelRegistry";
import { supportsLiveTranscriptionPreview } from "../../utils/transcriptionPreview";
import type { InferenceMode } from "../../types/electron";

const noop = () => {};

export default function SpeechToTextSettings() {
  const { t } = useTranslation();
  const {
    useLocalWhisper,
    setUseLocalWhisper,
    updateTranscriptionSettings,
    cloudTranscriptionProvider,
    setCloudTranscriptionProvider,
    cloudTranscriptionModel,
    setCloudTranscriptionModel,
    localTranscriptionProvider,
    setLocalTranscriptionProvider,
    whisperModel,
    setWhisperModel,
    parakeetModel,
    setParakeetModel,
    cohereModel,
    setCohereModel,
    cloudTranscriptionBaseUrl,
    setCloudTranscriptionBaseUrl,
    setCloudTranscriptionMode,
    transcriptionMode,
    setTranscriptionMode,
    remoteTranscriptionUrl,
    setRemoteTranscriptionUrl,
    remoteTranscriptionModel,
    setRemoteTranscriptionModel,
    showTranscriptionPreview,
    setShowTranscriptionPreview,
  } = useSettings();

  // "openwhispr" and "enterprise" no longer exist as choices; anything else collapses to local.
  const activeMode: InferenceMode =
    transcriptionMode === "providers" || transcriptionMode === "self-hosted"
      ? transcriptionMode
      : "local";

  const modes: InferenceModeOption[] = [
    {
      id: "local",
      label: t("settingsPage.transcription.modes.local"),
      description: t("settingsPage.transcription.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "providers",
      label: t("settingsPage.transcription.modes.providers"),
      description: t("settingsPage.transcription.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.transcription.modes.selfHosted"),
      description: t("settingsPage.transcription.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
  ];

  const selectMode = (mode: InferenceMode) => {
    if (mode === activeMode) return;
    setTranscriptionMode(mode);
    setUseLocalWhisper(mode === "local");
    updateTranscriptionSettings({ useLocalWhisper: mode === "local" });
    setCloudTranscriptionMode("byok");
  };

  const handleLocalModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? localTranscriptionProvider;
      if (provider === "nvidia") setParakeetModel(modelId);
      else if (provider === "cohere") setCohereModel(modelId);
      else setWhisperModel(modelId);
    },
    [localTranscriptionProvider, setParakeetModel, setCohereModel, setWhisperModel]
  );

  const selectedCloudModelStreams = Boolean(
    getTranscriptionProvider(cloudTranscriptionProvider)?.models.some(
      (model) => model.id === cloudTranscriptionModel && model.streaming
    )
  );
  const previewAvailable = supportsLiveTranscriptionPreview(activeMode, selectedCloudModelStreams);

  const picker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      selectedCloudProvider={cloudTranscriptionProvider}
      onCloudProviderSelect={setCloudTranscriptionProvider}
      selectedCloudModel={cloudTranscriptionModel}
      onCloudModelSelect={setCloudTranscriptionModel}
      selectedLocalModel={
        localTranscriptionProvider === "nvidia"
          ? parakeetModel
          : localTranscriptionProvider === "cohere"
            ? cohereModel
            : whisperModel
      }
      onLocalModelSelect={handleLocalModelSelect}
      selectedLocalProvider={localTranscriptionProvider}
      onLocalProviderSelect={setLocalTranscriptionProvider}
      useLocalWhisper={mode === "local"}
      onModeChange={noop}
      mode={mode}
      cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("simpleSettings.stt.title")}
        description={t("simpleSettings.stt.description")}
      />
      <InferenceModeSelector modes={modes} activeMode={activeMode} onSelect={selectMode} />
      {activeMode === "providers" && picker("cloud")}
      {activeMode === "local" && picker("local")}
      {activeMode === "self-hosted" && (
        <SelfHostedPanel
          service="transcription"
          url={remoteTranscriptionUrl}
          onUrlChange={setRemoteTranscriptionUrl}
          model={remoteTranscriptionModel}
          onModelChange={setRemoteTranscriptionModel}
        />
      )}
      {previewAvailable && (
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.transcription.transcriptionPreview")}
              description={t("settingsPage.transcription.transcriptionPreviewDescription")}
            >
              <Toggle checked={showTranscriptionPreview} onChange={setShowTranscriptionPreview} />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      )}
    </div>
  );
}

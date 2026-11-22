import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Monitor, Moon, Plus, Sun } from "../icons";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { AlertDialog, ConfirmDialog } from "../ui/dialog";
import { clearTranscriptions as clearTranscriptionStore } from "../../stores/transcriptionStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import LanguageSelector, { type LanguageOption } from "../ui/LanguageSelector";
import { HotkeyListInput } from "../ui/HotkeyListInput";
import { ActivationModeSelector } from "../ui/ActivationModeSelector";
import LinuxPttSetupInfo from "../ui/LinuxPttSetupInfo";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import SpokenRepliesSettings from "./SpokenRepliesSettings";
import MicrophoneSettings from "../ui/MicrophoneSettings";
import {
  MIN_ASSISTANT_CHAT_IDLE_MINUTES,
  MAX_ASSISTANT_CHAT_IDLE_MINUTES,
} from "../../helpers/overlay/assistantChatContinuity";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { useHotkeyRegistration } from "../../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../../hooks/useHotkeyModeInfo";
import { useTheme } from "../../hooks/useTheme";
import { useSettingsStore, type HotkeyRegistrationResult } from "../../stores/settingsStore";
import { validateHotkeyForSlot } from "../../utils/hotkeyValidation";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { getCachedPlatform } from "../../utils/platform";
import logger from "../../utils/logger";

const UI_LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "ar", label: "العربية", flag: "🇦🇪" },
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
  { value: "it", label: "Italiano", flag: "🇮🇹" },
  { value: "ru", label: "Русский", flag: "🇷🇺" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { value: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
];

function CustomWordsList() {
  const { t } = useTranslation();
  const { customDictionary, updateCustomDictionary } = useSettings();
  const [draft, setDraft] = useState("");

  const add = () => {
    const word = draft.trim();
    if (!word) return;
    const exists = customDictionary.some((w) => w.toLowerCase() === word.toLowerCase());
    if (!exists) updateCustomDictionary({ add: [word] });
    setDraft("");
  };

  return (
    <SettingsPanelRow>
      <div className="space-y-2.5">
        <div>
          <p className="text-xs font-medium text-foreground">
            {t("simpleSettings.customWords.title")}
          </p>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("simpleSettings.customWords.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={t("simpleSettings.customWords.placeholder")}
            className="h-8 text-xs"
          />
          <Button size="sm" variant="outline" onClick={add} disabled={!draft.trim()}>
            <Plus className="me-1 h-3.5 w-3.5" />
            {t("simpleSettings.customWords.add")}
          </Button>
        </div>
        {customDictionary.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">
            {t("simpleSettings.customWords.empty")}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {customDictionary.map((word) => (
              <li
                key={word}
                className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-surface-1/80 ps-2 pe-1 py-0.5 text-xs"
              >
                <span dir="auto">{word}</span>
                <button
                  type="button"
                  aria-label={t("simpleSettings.customWords.remove", { word })}
                  onClick={() => updateCustomDictionary({ remove: [word] })}
                  className="rounded px-1 text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsPanelRow>
  );
}

export default function PreferencesSettings() {
  const { t } = useTranslation();
  const {
    alertDialog,
    showAlertDialog,
    hideAlertDialog,
    confirmDialog,
    showConfirmDialog,
    hideConfirmDialog,
  } = useDialogs();

  const handleClearHistory = () => {
    showConfirmDialog({
      title: t("simpleSettings.data.confirmTitle"),
      description: t("simpleSettings.data.confirmDescription"),
      confirmText: t("simpleSettings.data.clearButton"),
      variant: "destructive",
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          if (result?.success) clearTranscriptionStore();
          showAlertDialog({
            title: result?.success
              ? t("simpleSettings.data.done")
              : t("simpleSettings.data.failed"),
          });
        } catch {
          showAlertDialog({ title: t("simpleSettings.data.failed") });
        }
      },
    });
  };

  const handleForgetChats = () => {
    showConfirmDialog({
      title: t("settingsPage.general.chatMemory.forgetTitle"),
      description: t("simpleSettings.data.forgetChatsDescription"),
      confirmText: t("simpleSettings.data.forgetButton"),
      variant: "destructive",
      onConfirm: async () => {
        const result = await window.electronAPI?.overlayMemoryClear?.();
        showAlertDialog({
          title: result?.success
            ? t("settingsPage.general.chatMemory.forgetDone")
            : t("settingsPage.general.chatMemory.forgetFailed"),
        });
      },
    });
  };
  const platform = getCachedPlatform();
  const { theme, setTheme } = useTheme();
  const {
    uiLanguage,
    setUiLanguage,
    preferredLanguage,
    updateTranscriptionSettings,
    startMinimized,
    setStartMinimized,
    microphoneSelectionMode,
    selectedMicDeviceId,
    selectedMicDeviceLabel,
    micWarmHoldSeconds,
    setMicrophoneSelectionMode,
    setSelectedMicDevice,
    setMicWarmHoldSeconds,
  } = useSettings();
  const assistantChatIdleMinutes = useSettingsStore((s) => s.assistantChatIdleMinutes);
  const setAssistantChatIdleMinutes = useSettingsStore((s) => s.setAssistantChatIdleMinutes);
  const commandModeEnabled = useSettingsStore((s) => s.commandModeEnabled);
  const setCommandModeEnabled = useSettingsStore((s) => s.setCommandModeEnabled);
  const commandModeAutoRunTrusted = useSettingsStore((s) => s.commandModeAutoRunTrusted);
  const setCommandModeAutoRunTrusted = useSettingsStore((s) => s.setCommandModeAutoRunTrusted);

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartNeedsApproval, setAutoStartNeedsApproval] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);
  const [runAsAdminEnabled, setRunAsAdminEnabled] = useState(false);
  const [runAsAdminLoading, setRunAsAdminLoading] = useState(platform === "win32");

  const readAutoStartState = useCallback(async () => {
    if (!window.electronAPI?.getAutoStartEnabled) return;
    try {
      const state = await window.electronAPI.getAutoStartEnabled();
      setAutoStartEnabled(state.enabled);
      setAutoStartNeedsApproval(state.requiresApproval);
    } catch (error) {
      logger.error("Failed to get auto-start status", error, "settings");
    }
  }, []);

  const readRunAsAdminState = useCallback(async () => {
    if (platform !== "win32" || !window.electronAPI?.getRunAsAdmin) return;
    try {
      const state = await window.electronAPI.getRunAsAdmin();
      setRunAsAdminEnabled(!!state.enabled);
    } catch (error) {
      logger.error("Failed to get run-as-admin status", error, "settings");
    }
  }, [platform]);

  useEffect(() => {
    readAutoStartState().finally(() => setAutoStartLoading(false));
  }, [readAutoStartState]);

  useEffect(() => {
    if (platform !== "win32") return;
    readRunAsAdminState().finally(() => setRunAsAdminLoading(false));
  }, [platform, readRunAsAdminState]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (!window.electronAPI?.setAutoStartEnabled) return;
    try {
      setAutoStartLoading(true);
      const result = await window.electronAPI.setAutoStartEnabled(enabled);
      if (result.success) await readAutoStartState();
    } catch (error) {
      logger.error("Failed to set auto-start", error, "settings");
    } finally {
      setAutoStartLoading(false);
    }
  };

  const handleRunAsAdminChange = async (enabled: boolean) => {
    if (!window.electronAPI?.setRunAsAdmin) return;
    try {
      setRunAsAdminLoading(true);
      const result = await window.electronAPI.setRunAsAdmin(enabled);
      if (result?.relaunched) return;
      await readRunAsAdminState();
      await readAutoStartState();
    } catch (error) {
      logger.error("Failed to set run-as-admin", error, "settings");
    } finally {
      setRunAsAdminLoading(false);
    }
  };

  const themeOptions = [
    { value: "light", icon: Sun, label: t("settingsPage.general.appearance.light") },
    { value: "dark", icon: Moon, label: t("settingsPage.general.appearance.dark") },
    { value: "auto", icon: Monitor, label: t("settingsPage.general.appearance.auto") },
  ] as const;

  return (
    <div className="space-y-6">
      <div>
        <SectionHeader
          title={t("simpleSettings.dictation.title")}
          description={t("simpleSettings.dictation.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settings.language.transcriptionLabel")}
              description={t("settings.language.transcriptionDescription")}
            >
              <LanguageSelector
                value={preferredLanguage}
                onChange={(value) => updateTranscriptionSettings({ preferredLanguage: value })}
              />
            </SettingsRow>
          </SettingsPanelRow>
          <CustomWordsList />
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader
          title={t("settingsPage.general.commandMode.title")}
          description={t("settingsPage.general.commandMode.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.general.commandMode.enabled")}
              description={t("settingsPage.general.commandMode.enabledDescription")}
            >
              <Toggle checked={commandModeEnabled} onChange={setCommandModeEnabled} />
            </SettingsRow>
          </SettingsPanelRow>
          {commandModeEnabled && (
            <>
              <SettingsPanelRow>
                <SettingsRow
                  label={t("settingsPage.general.commandMode.autoRunTrusted")}
                  description={t("settingsPage.general.commandMode.autoRunTrustedDescription")}
                >
                  <Toggle
                    checked={commandModeAutoRunTrusted}
                    onChange={setCommandModeAutoRunTrusted}
                  />
                </SettingsRow>
              </SettingsPanelRow>
            </>
          )}
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader
          title={t("settingsPage.general.spokenReplies.title")}
          description={t("settingsPage.general.spokenReplies.description")}
        />
        <SpokenRepliesSettings mode="all" />
      </div>

      <div>
        <SectionHeader
          title={t("settingsPage.general.microphone.title")}
          description={t("settingsPage.general.microphone.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <MicrophoneSettings
              microphoneSelectionMode={microphoneSelectionMode}
              selectedMicDeviceId={selectedMicDeviceId}
              selectedMicDeviceLabel={selectedMicDeviceLabel}
              micWarmHoldSeconds={micWarmHoldSeconds}
              onSelectionModeChange={setMicrophoneSelectionMode}
              onDeviceSelect={setSelectedMicDevice}
              onMicWarmHoldSecondsChange={setMicWarmHoldSeconds}
            />
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader
          title={t("simpleSettings.app.title")}
          description={t("simpleSettings.app.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t(
                platform === "win32"
                  ? "settingsPage.general.startup.launchAtLoginWindows"
                  : "settingsPage.general.startup.launchAtLogin"
              )}
              description={t(
                platform === "win32"
                  ? "settingsPage.general.startup.launchAtLoginWindowsDescription"
                  : "settingsPage.general.startup.launchAtLoginDescription"
              )}
            >
              <Toggle
                checked={autoStartEnabled}
                onChange={(checked: boolean) => handleAutoStartChange(checked)}
                disabled={autoStartLoading}
              />
            </SettingsRow>
          </SettingsPanelRow>
          {autoStartNeedsApproval && (
            <SettingsPanelRow>
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t("settingsPage.general.startup.needsApproval.title")}</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{t("settingsPage.general.startup.needsApproval.description")}</p>
                  <Button
                    onClick={() => void window.electronAPI?.openLoginItemsSettings?.()}
                    variant="outline"
                    size="sm"
                  >
                    {t("settingsPage.general.startup.needsApproval.action")}
                  </Button>
                </AlertDescription>
              </Alert>
            </SettingsPanelRow>
          )}
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.general.startup.startMinimized")}
              description={t("settingsPage.general.startup.startMinimizedDescription")}
            >
              <Toggle checked={startMinimized} onChange={setStartMinimized} />
            </SettingsRow>
          </SettingsPanelRow>
          {platform === "win32" && (
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.general.startup.runAsAdministrator")}
                description={t("settingsPage.general.startup.runAsAdministratorDescription")}
              >
                <Toggle
                  checked={runAsAdminEnabled}
                  onChange={(checked: boolean) => void handleRunAsAdminChange(checked)}
                  disabled={runAsAdminLoading}
                />
              </SettingsRow>
              <p className="text-xs text-muted-foreground">
                {t("settingsPage.general.startup.runAsAdministratorWarning")}
              </p>
            </SettingsPanelRow>
          )}
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.general.appearance.theme")}
              description={t("settingsPage.general.appearance.themeDescription")}
            >
              <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                {themeOptions.map((option) => {
                  const Icon = option.icon;
                  const isSelected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      onClick={() => setTheme(option.value)}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-xs font-medium transition-colors duration-100 ${
                        isSelected
                          ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.general.commandMode.idleMinutes")}
              description={t("settingsPage.general.commandMode.idleMinutesDescription")}
            >
              <input
                data-testid="assistant-chat-idle-minutes"
                type="number"
                min={MIN_ASSISTANT_CHAT_IDLE_MINUTES}
                max={MAX_ASSISTANT_CHAT_IDLE_MINUTES}
                value={assistantChatIdleMinutes}
                onChange={(e) => setAssistantChatIdleMinutes(Number(e.target.value))}
                className="h-7 w-16 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settings.language.uiLabel")}
              description={t("settings.language.uiDescription")}
            >
              <LanguageSelector
                value={uiLanguage}
                onChange={setUiLanguage}
                options={UI_LANGUAGE_OPTIONS}
                className="min-w-32"
              />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader title={t("simpleSettings.data.title")} />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("simpleSettings.data.clearHistory")}
              description={t("simpleSettings.data.clearHistoryDescription")}
            >
              <Button variant="outline" size="sm" onClick={handleClearHistory}>
                {t("simpleSettings.data.clearButton")}
              </Button>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("simpleSettings.data.forgetChats")}
              description={t("simpleSettings.data.forgetChatsDescription")}
            >
              <Button variant="outline" size="sm" onClick={handleForgetChats}>
                {t("simpleSettings.data.forgetButton")}
              </Button>
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />
    </div>
  );
}

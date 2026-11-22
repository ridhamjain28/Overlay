import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { AlertDialog } from "../ui/dialog";
import { HotkeyListInput } from "../ui/HotkeyListInput";
import { ActivationModeSelector } from "../ui/ActivationModeSelector";
import LinuxPttSetupInfo from "../ui/LinuxPttSetupInfo";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { useHotkeyRegistration } from "../../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../../hooks/useHotkeyModeInfo";
import { useSettingsStore, type HotkeyRegistrationResult } from "../../stores/settingsStore";
import { validateHotkeyForSlot } from "../../utils/hotkeyValidation";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { getCachedPlatform } from "../../utils/platform";

export default function HotkeysSettings() {
  const { t } = useTranslation();
  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const platform = getCachedPlatform();
  const { dictationKey, setDictationKey, activationMode, setActivationMode } = useSettings();
  const voiceAgentKey = useSettingsStore((s) => s.voiceAgentKey);
  const setVoiceAgentKey = useSettingsStore((s) => s.setVoiceAgentKey);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => setDictationKey(registeredHotkey),
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const [isAssistantHotkeyCommitting, setIsAssistantHotkeyCommitting] = useState(false);
  const commitAssistantHotkey = useCallback(
    async (key: string) => {
      setIsAssistantHotkeyCommitting(true);
      try {
        const result: HotkeyRegistrationResult = await setVoiceAgentKey(key);
        if (!result.success) {
          showAlertDialog({
            title: t("hooks.hotkeyRegistration.titles.notRegistered"),
            description: result.message || t("hooks.hotkeyRegistration.errors.failedToRegister"),
          });
        }
        return result.success;
      } finally {
        setIsAssistantHotkeyCommitting(false);
      }
    },
    [setVoiceAgentKey, showAlertDialog, t]
  );

  const validateDictationHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(
        hotkey,
        { "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey },
        t
      ),
    [voiceAgentKey, t]
  );
  const validateAssistantHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(hotkey, { "settingsPage.general.hotkey.title": dictationKey }, t),
    [dictationKey, t]
  );

  const {
    isUsingNativeShortcut,
    isUsingHyprland,
    hyprlandConfigStatus,
    pushToTalkUnavailableReason,
    linuxInputAccessDenied,
  } = useHotkeyModeInfo("settings", dictationKey);
  const [effectiveDefaultHotkey, setEffectiveDefaultHotkey] = useState<string | null>(null);
  const [linuxPttAvailable, setLinuxPttAvailable] = useState(true);

  useEffect(() => {
    window.electronAPI
      ?.getEffectiveDefaultHotkey?.()
      .then((value: string | null | undefined) => {
        if (value) setEffectiveDefaultHotkey(value);
      })
      .catch(() => {});
    const cleanup = window.electronAPI?.onLinuxPttPermissionDenied?.(() =>
      setLinuxPttAvailable(false)
    );
    return () => cleanup?.();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <SectionHeader
          title={t("settingsPage.general.hotkey.title")}
          description={t("settingsPage.general.hotkey.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            {isUsingHyprland && hyprlandConfigStatus && !hyprlandConfigStatus.canWrite && (
              <Alert className="mb-3">
                <AlertTitle>
                  {t("settingsPage.general.hotkey.hyprlandConfigWriteWarningTitle")}
                </AlertTitle>
                <AlertDescription>
                  <BidiInterpolatedText
                    text={t("settingsPage.general.hotkey.hyprlandConfigWriteWarningDescription", {
                      path: BIDI_VALUE_TOKEN,
                    })}
                    value={hyprlandConfigStatus.path}
                  />
                </AlertDescription>
              </Alert>
            )}
            <p className="mb-2 text-xs font-medium text-foreground">
              {t("settingsPage.general.hotkey.title")}
            </p>
            <HotkeyListInput
              value={dictationKey}
              onChange={(list) => registerHotkey(list)}
              validate={validateDictationHotkey}
              disabled={isHotkeyRegistering}
              maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
              required
              footerEnd={
                effectiveDefaultHotkey &&
                dictationKey &&
                dictationKey !== effectiveDefaultHotkey ? (
                  <button
                    onClick={() => registerHotkey(effectiveDefaultHotkey)}
                    disabled={isHotkeyRegistering}
                    className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <BidiInterpolatedText
                      text={t("settingsPage.general.hotkey.resetToDefault", {
                        hotkey: BIDI_VALUE_TOKEN,
                      })}
                      value={formatHotkeyLabel(effectiveDefaultHotkey)}
                    />
                  </button>
                ) : null
              }
            />
          </SettingsPanelRow>
          {(!isUsingNativeShortcut || platform === "linux") && (
            <SettingsPanelRow>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground/80">
                  {t("settingsPage.general.hotkey.activationMode")}
                </span>
                <ActivationModeSelector
                  value={activationMode}
                  onChange={setActivationMode}
                  pushDisabledReason={pushToTalkUnavailableReason ?? undefined}
                />
              </div>
              {pushToTalkUnavailableReason && !linuxInputAccessDenied && (
                <p className="mt-2 text-xs text-muted-foreground">{pushToTalkUnavailableReason}</p>
              )}
              {platform === "linux" && (activationMode === "push" || linuxInputAccessDenied) && (
                <LinuxPttSetupInfo isAvailable={!linuxInputAccessDenied && linuxPttAvailable} />
              )}
            </SettingsPanelRow>
          )}
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader
          title={t("simpleSettings.command.hotkeyTitle")}
          description={t("simpleSettings.command.hotkeyDescription")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <HotkeyListInput
              value={voiceAgentKey}
              onChange={(list) => commitAssistantHotkey(list)}
              onClear={() => commitAssistantHotkey("")}
              validate={validateAssistantHotkey}
              disabled={isAssistantHotkeyCommitting}
              maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
            />
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

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

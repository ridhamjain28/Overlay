import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  MIN_ASSISTANT_CHAT_IDLE_MINUTES,
  MAX_ASSISTANT_CHAT_IDLE_MINUTES,
} from "../../helpers/overlay/assistantChatContinuity";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";

export function CommandModeSettings() {
  const { t } = useTranslation();
  const commandModeEnabled = useSettingsStore((s) => s.commandModeEnabled);
  const setCommandModeEnabled = useSettingsStore((s) => s.setCommandModeEnabled);
  const commandModeAutoRunTrusted = useSettingsStore((s) => s.commandModeAutoRunTrusted);
  const setCommandModeAutoRunTrusted = useSettingsStore((s) => s.setCommandModeAutoRunTrusted);
  const commandModeParser = useSettingsStore((s) => s.commandModeParser);
  const setCommandModeParser = useSettingsStore((s) => s.setCommandModeParser);
  const assistantChatIdleMinutes = useSettingsStore((s) => s.assistantChatIdleMinutes);
  const setAssistantChatIdleMinutes = useSettingsStore((s) => s.setAssistantChatIdleMinutes);

  return (
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
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.general.commandMode.parser")}
                description={t("settingsPage.general.commandMode.parserDescription")}
              >
                <select
                  data-testid="command-mode-parser"
                  value={commandModeParser}
                  onChange={(e) =>
                    setCommandModeParser(e.target.value === "cloud" ? "cloud" : "local")
                  }
                  className="h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 transition-colors duration-200"
                >
                  <option value="local">{t("settingsPage.general.commandMode.parserLocal")}</option>
                  <option value="cloud">{t("settingsPage.general.commandMode.parserCloud")}</option>
                </select>
              </SettingsRow>
            </SettingsPanelRow>
          </>
        )}
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
              className="h-7 w-16 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 transition-colors duration-200"
            />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}

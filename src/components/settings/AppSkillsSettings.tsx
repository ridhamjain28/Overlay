import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";

type SkillRow = {
  appId: string;
  name: string;
  enabled?: boolean;
  source?: string;
  alwaysAvailable?: boolean;
  actions?: Array<{ id: string; description?: string }>;
};

type Learned = { id: string; utterance: string; appId?: string; actionId?: string };

export default function AppSkillsSettings() {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState("");
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(0);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [learned, setLearned] = useState<Learned[]>([]);
  const [testMessage, setTestMessage] = useState("");

  const load = useCallback(async () => {
    const state = await window.electronAPI?.overlayAppInventoryGet?.();
    if (state) {
      setCount(state.summary?.count || state.skills?.length || 0);
      setReady(state.summary?.ready || 0);
      setSkills(((state.skills as SkillRow[]) || []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    }
    const learnedState = await window.electronAPI?.overlayLearnedExamplesList?.();
    setLearned((learnedState?.examples as Learned[]) || []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rescan = async () => {
    setScanning(true);
    setTestMessage("");
    try {
      const result = await window.electronAPI?.overlayAppInventoryScan?.();
      if (result) {
        setCount(result.summary?.count || 0);
        setReady(result.summary?.ready || 0);
        setSkills(((result.skills as SkillRow[]) || []).slice().sort((a, b) => a.name.localeCompare(b.name)));
      }
    } finally {
      setScanning(false);
    }
  };

  const toggle = async (appId: string, enabled: boolean) => {
    await window.electronAPI?.overlayAppSkillsSetEnabled?.({ appId, enabled });
    setSkills((current) => current.map((skill) => (skill.appId === appId ? { ...skill, enabled } : skill)));
  };

  const testAction = async (skill: SkillRow) => {
    const actionId = skill.actions?.find((action) => action.id === "launch" || action.id === "open")?.id || skill.actions?.[0]?.id;
    const result = await window.electronAPI?.overlayAppSkillsTest?.({ appId: skill.appId, actionId });
    setTestMessage(
      result?.success
        ? t("simpleSettings.appsSkills.testOk", { action: actionId || skill.name })
        : t("simpleSettings.appsSkills.testFailed")
    );
  };

  const removeLearned = async (id: string) => {
    await window.electronAPI?.overlayLearnedExamplesDelete?.(id);
    setLearned((current) => current.filter((item) => item.id !== id));
  };

  const visible = skills.filter((skill) => skill.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <>
      <SectionHeader
        title={t("simpleSettings.appsSkills.title")}
        description={t("simpleSettings.appsSkills.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("simpleSettings.appsSkills.summary", { count, ready })}
            </p>
            <Button size="sm" variant="outline" onClick={() => void rescan()} disabled={scanning}>
              {scanning ? t("simpleSettings.appsSkills.scanning") : t("simpleSettings.appsSkills.rescan")}
            </Button>
          </div>
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("simpleSettings.appsSkills.search")}
            className="mt-2 h-8 text-xs"
          />
          {visible.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">{t("simpleSettings.appsSkills.noApps")}</p>
          ) : (
            <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
              {visible.map((skill) => (
                <li key={skill.appId} className="flex items-center justify-between gap-2 rounded-md px-1 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{skill.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {skill.source === "db" || skill.alwaysAvailable
                        ? t("onboarding.findApps.readyBadge")
                        : t("onboarding.findApps.genericBadge")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => void testAction(skill)}>
                      {t("simpleSettings.appsSkills.test")}
                    </Button>
                    <Toggle
                      checked={skill.enabled !== false}
                      onChange={(enabled) => void toggle(skill.appId, enabled)}
                      ariaLabel={t("simpleSettings.appsSkills.enabled")}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {testMessage ? <p className="mt-2 text-xs text-muted-foreground">{testMessage}</p> : null}
        </SettingsPanelRow>
        <SettingsPanelRow>
          <p className="text-xs font-medium">{t("simpleSettings.appsSkills.learnedTitle")}</p>
          {learned.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">{t("simpleSettings.appsSkills.learnedEmpty")}</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {learned.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate">
                    {item.utterance}
                    {item.appId ? ` · ${item.appId}` : ""}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void removeLearned(item.id)}>
                    {t("simpleSettings.appsSkills.learnedDelete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsPanelRow>
      </SettingsPanel>
    </>
  );
}

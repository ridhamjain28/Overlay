import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";

type SkillRow = {
  appId: string;
  name: string;
  enabled?: boolean;
  source?: string;
  alwaysAvailable?: boolean;
  actions?: Array<{ id: string }>;
};

export default function FindAppsStep({
  onReadinessChange,
}: {
  onReadinessChange?: (ready: boolean) => void;
}) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(true);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(0);
  const [skills, setSkills] = useState<SkillRow[]>([]);

  const applyResult = useCallback(
    (result: {
      catalog?: { apps?: Array<{ id?: string; name?: string; ready?: boolean; enabled?: boolean; source?: string }> };
      skills?: SkillRow[];
      summary?: { count: number; ready: number };
    }) => {
      const summary = result.summary || {
        count: result.catalog?.apps?.length || result.skills?.length || 0,
        ready: (result.catalog?.apps || []).filter((app) => app.ready).length,
      };
      setCount(summary.count);
      setReady(summary.ready);
      setSkills(
        (result.skills || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      );
      setScanning(false);
      onReadinessChange?.(true);
    },
    [onReadinessChange]
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    setError("");
    onReadinessChange?.(false);
    const api = window.electronAPI;
    const stop = api?.onOverlayAppInventoryProgress?.((payload) => {
      setProgress(payload?.message || payload?.stage || "");
    });
    try {
      const result = await api?.overlayAppInventoryScan?.();
      if (!result) throw new Error("unavailable");
      applyResult(result as Parameters<typeof applyResult>[0]);
    } catch {
      setError("scan");
      setScanning(false);
    } finally {
      stop?.();
    }
  }, [applyResult, onReadinessChange]);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  const toggle = async (appId: string, enabled: boolean) => {
    const result = await window.electronAPI?.overlayAppSkillsSetEnabled?.({ appId, enabled });
    if (result?.skill) {
      setSkills((current) =>
        current.map((skill) => (skill.appId === appId ? { ...skill, enabled } : skill))
      );
    }
  };

  if (scanning) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-4 pt-2">
        <p className="text-sm text-muted-foreground">
          {t("onboarding.findApps.descriptionScanning")}
        </p>
        <p className="text-sm font-medium">{t("onboarding.findApps.progress", { stage: progress || "…" })}</p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-primary/70" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col gap-3 pt-2">
        <p className="text-sm text-muted-foreground">{t("onboarding.findApps.error")}</p>
        <Button size="sm" variant="outline" onClick={() => void runScan()}>
          {t("onboarding.findApps.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden pt-1">
      <p className="text-sm text-muted-foreground">{t("onboarding.findApps.descriptionDone")}</p>
      <p className="text-xs font-medium text-foreground">
        {t("onboarding.findApps.titleDone", { count, ready })}
      </p>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
        {skills.map((skill) => (
          <li key={skill.appId} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{skill.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {skill.source === "db" || skill.alwaysAvailable
                  ? t("onboarding.findApps.readyBadge")
                  : t("onboarding.findApps.genericBadge")}
              </p>
            </div>
            <Toggle
              checked={skill.enabled !== false}
              onChange={(enabled) => void toggle(skill.appId, enabled)}
              ariaLabel={skill.name}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

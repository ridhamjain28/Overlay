import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, Search } from "../icons";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import AppScanProgress from "../overlay/AppScanProgress";
import OnboardingList from "./OnboardingList";
import { OnboardingStepHeader } from "./OnboardingShell";
import { useOverlayAppsScan, type OverlayAppsScanStatus } from "../../hooks/useOverlayAppsScan";
import { filterAppRows, getOverlayAppsApi, mergeAppRows } from "../../utils/overlayApps";
import logger from "../../utils/logger";

interface FindingAppsStepProps {
  /** Lets the flow decide between Skip (scanning / failed; the footer offers it) and Continue (done). */
  onStatusChange?: (status: OverlayAppsScanStatus) => void;
}

/**
 * Onboarding step "Finding your apps…": scans installed apps with live progress,
 * then shows what was found, matched apps first, each with an on/off toggle.
 */
export default function FindingAppsStep({ onStatusChange }: FindingAppsStepProps) {
  const { t } = useTranslation();
  const { status, progress, result, error, run } = useOverlayAppsScan(true);
  const [query, setQuery] = useState("");
  // Optimistic toggle state, keyed by appId, so a click feels instant.
  const [enabledOverrides, setEnabledOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  const rows = useMemo(() => mergeAppRows(result, []), [result]);
  const visibleRows = useMemo(() => filterAppRows(rows, query), [rows, query]);

  const setAppEnabled = useCallback(async (appId: string, enabled: boolean) => {
    const api = getOverlayAppsApi();
    if (!api) return;
    setEnabledOverrides((prev) => ({ ...prev, [appId]: enabled }));
    try {
      await api.setEnabled({ appId, enabled });
    } catch (err) {
      logger.warn("Could not change an app's enabled state", { appId, err }, "onboarding");
      setEnabledOverrides((prev) => ({ ...prev, [appId]: !enabled }));
    }
  }, []);

  if (status === "unavailable") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-4 pt-2">
        <OnboardingStepHeader
          title={t("appSkills.onboarding.title")}
          wideTitle
          description={t("appSkills.notAvailable")}
        />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-4 pt-2">
        <OnboardingStepHeader
          title={t("appSkills.onboarding.title")}
          wideTitle
          description={t("appSkills.onboarding.description")}
        />
        <div
          role="alert"
          className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-5 text-center"
        >
          <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-[var(--onboarding-text-primary)]">
            {t("appSkills.scanFailed")}
          </p>
          {error && (
            <p
              dir="auto"
              className="max-w-full break-words text-xs text-[var(--onboarding-text-secondary)]"
            >
              {error}
            </p>
          )}
          <Button size="sm" onClick={() => void run()}>
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (status !== "done" || !result) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-6 pt-2">
        <OnboardingStepHeader
          title={t("appSkills.onboarding.title")}
          wideTitle
          description={t("appSkills.onboarding.description")}
        />
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4">
          <Loader2
            className="size-6 animate-spin text-[var(--onboarding-text-secondary)]"
            aria-hidden="true"
          />
          <AppScanProgress progress={progress} variant="onboarding" />
        </div>
      </div>
    );
  }

  const searchPlaceholder = t("appSkills.searchPlaceholder");

  return (
    <div className="flex h-full min-h-0 w-full flex-col pt-1">
      <OnboardingStepHeader
        title={t("appSkills.onboarding.title")}
        wideTitle
        description={t("appSkills.onboarding.summary", {
          found: result.found,
          withCommands: result.withCommands,
        })}
      />
      <div className="mx-auto mt-4 flex min-h-0 w-full max-w-md flex-1 flex-col gap-2">
        <label className="relative block">
          <Search
            className="pointer-events-none absolute start-3.5 top-1/2 size-5 -translate-y-1/2 text-[var(--onboarding-text-tertiary)]"
            strokeWidth={2}
          />
          <input
            dir="auto"
            type="search"
            aria-label={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="onboarding-light-input onboarding-light-input-bordered w-full rounded-full! border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] py-2.5 ps-11 pe-3.5 text-base leading-[1.4] text-[var(--onboarding-text-primary)] shadow-none! outline-none placeholder:text-[var(--onboarding-text-tertiary)] focus:border-[var(--onboarding-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--onboarding-accent)_15%,transparent)]"
          />
        </label>

        <OnboardingList className="min-h-0 flex-1">
          {visibleRows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--onboarding-text-secondary)]">
              {t("appSkills.noAppsFound")}
            </p>
          ) : (
            visibleRows.map((row) => {
              const enabled = enabledOverrides[row.appId] ?? row.enabled;
              return (
                <div key={row.appId} className="onboarding-list-row w-full">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      dir="auto"
                      className="truncate text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]"
                    >
                      {row.name}
                    </span>
                    <span className="truncate text-xs font-normal leading-[1.4] text-[var(--onboarding-text-secondary)]">
                      {row.matched
                        ? t("appSkills.readyCommands", { n: row.actionsCount })
                        : t("appSkills.noCommandsYet")}
                    </span>
                  </span>
                  <Toggle
                    checked={enabled}
                    onChange={(next) => void setAppEnabled(row.appId, next)}
                    ariaLabel={t("appSkills.enableApp", { name: row.name })}
                  />
                </div>
              );
            })
          )}
        </OnboardingList>
      </div>
    </div>
  );
}

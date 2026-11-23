import { useTranslation } from "react-i18next";
import type { OverlayAppsScanProgress } from "../../types/overlayApps";
import { scanProgressPercent } from "../../utils/overlayApps";

/** Progress bar plus the current phase's label, for an app scan in flight. */
export default function AppScanProgress({
  progress,
  variant = "settings",
}: {
  progress: OverlayAppsScanProgress | null;
  variant?: "settings" | "onboarding";
}) {
  const { t } = useTranslation();
  const percent = scanProgressPercent(progress);
  const label = progress
    ? t(`appSkills.phase.${progress.phase}`, { defaultValue: t("appSkills.phase.default") })
    : t("appSkills.phase.default");
  const onboarding = variant === "onboarding";

  return (
    <div className="w-full space-y-2" role="status" aria-live="polite">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
        className={`h-1.5 w-full overflow-hidden rounded-full ${
          onboarding ? "bg-[var(--onboarding-control-border)]" : "bg-muted"
        }`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${
            onboarding ? "bg-[var(--onboarding-accent)]" : "bg-primary"
          }`}
          style={{ width: `${Math.max(percent, 3)}%` }}
        />
      </div>
      <p
        className={`text-xs ${
          onboarding
            ? "text-center text-[var(--onboarding-text-secondary)]"
            : "text-muted-foreground/80"
        }`}
      >
        {label}
      </p>
    </div>
  );
}

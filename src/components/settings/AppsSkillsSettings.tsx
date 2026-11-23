import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Trash2, X } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import AppScanProgress from "../overlay/AppScanProgress";
import { useOverlayAppsScan } from "../../hooks/useOverlayAppsScan";
import type { AppSkill, AppSkillAction, Learned, ScanResult } from "../../types/overlayApps";
import {
  errorMessage,
  filterAppRows,
  formatDateTime,
  getOverlayAppsApi,
  isActionEnabled,
  mergeAppRows,
  testParamsForAction,
  type AppRow,
} from "../../utils/overlayApps";
import logger from "../../utils/logger";

type TestState = { status: "testing" } | { status: "ok" } | { status: "error"; error: string };

const BADGE_BASE = "text-xs font-medium px-1.5 py-px rounded-sm";

function Badge({ tone, children }: { tone: "good" | "muted" | "warn"; children: React.ReactNode }) {
  const toneClass =
    tone === "good"
      ? "text-success bg-success/10"
      : tone === "warn"
        ? "text-warning bg-warning/10"
        : "text-muted-foreground bg-muted/80 dark:bg-surface-3";
  return <span className={`${BADGE_BASE} ${toneClass}`}>{children}</span>;
}

function ActionRow({
  appId,
  appEnabled,
  action,
  onToggle,
}: {
  appId: string;
  appEnabled: boolean;
  action: AppSkillAction;
  onToggle: (action: AppSkillAction, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [test, setTest] = useState<TestState | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runTest = async () => {
    const api = getOverlayAppsApi();
    if (!api) return;
    setTest({ status: "testing" });
    try {
      const result = await api.test({
        appId,
        actionId: action.id,
        params: testParamsForAction(action),
      });
      if (!mountedRef.current) return;
      setTest(
        result.ok
          ? { status: "ok" }
          : { status: "error", error: result.error ?? t("appSkills.unknownError") }
      );
    } catch (error) {
      if (!mountedRef.current) return;
      setTest({ status: "error", error: errorMessage(error) || t("appSkills.unknownError") });
    }
  };

  const example = action.examples?.[0]?.utterance;
  const enabled = isActionEnabled(action);

  return (
    <div className="space-y-1.5 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span dir="auto" className="text-xs font-medium text-foreground">
              {action.description || action.id}
            </span>
            <Badge tone={action.risk === "confirm" ? "warn" : "good"}>
              {action.risk === "confirm" ? t("appSkills.risk.confirm") : t("appSkills.risk.safe")}
            </Badge>
          </div>
          {example && (
            <p dir="auto" className="mt-0.5 text-xs text-muted-foreground/80">
              {t("appSkills.example", { utterance: example })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={test?.status === "testing"}
            onClick={() => void runTest()}
          >
            {test?.status === "testing" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {test?.status === "testing" ? t("appSkills.testing") : t("appSkills.test")}
          </Button>
          <Toggle
            checked={enabled}
            disabled={!appEnabled}
            onChange={(next) => onToggle(action, next)}
            ariaLabel={t("appSkills.enableAction", { action: action.description || action.id })}
          />
        </div>
      </div>
      {test && test.status !== "testing" && (
        <p
          role="status"
          dir="auto"
          className={`flex items-center gap-1.5 text-xs ${
            test.status === "ok" ? "text-success" : "text-destructive"
          }`}
        >
          {test.status === "ok" ? (
            <>
              <Check className="size-3.5 shrink-0" aria-hidden="true" />
              {t("appSkills.testOk")}
            </>
          ) : (
            <>
              <X className="size-3.5 shrink-0" aria-hidden="true" />
              {t("appSkills.testFailed", { error: test.error })}
            </>
          )}
        </p>
      )}
    </div>
  );
}

function AppRowItem({
  row,
  expanded,
  onExpand,
  onToggleApp,
  onToggleAction,
}: {
  row: AppRow;
  expanded: boolean;
  onExpand: () => void;
  onToggleApp: (row: AppRow, enabled: boolean) => void;
  onToggleAction: (row: AppRow, action: AppSkillAction, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const actions = row.skill?.actions ?? [];
  const expandable = actions.length > 0;

  return (
    <SettingsPanelRow>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onExpand}
          disabled={!expandable}
          aria-expanded={expandable ? expanded : undefined}
          aria-label={t(expanded ? "appSkills.hideCommands" : "appSkills.showCommands", {
            name: row.name,
          })}
          className="flex min-w-0 flex-1 items-center gap-2 text-start disabled:cursor-default"
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {expandable ? (
              expanded ? (
                <ChevronDown className="size-4 rtl:rotate-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
              )
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span dir="auto" className="truncate text-xs font-medium text-foreground">
                {row.name}
              </span>
              {row.matched ? (
                <Badge tone="good">{t("appSkills.matched")}</Badge>
              ) : (
                <Badge tone="muted">{t("appSkills.unmatched")}</Badge>
              )}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground/80">
              {row.matched
                ? t("appSkills.readyCommands", { n: row.actionsCount })
                : t("appSkills.noCommandsYet")}
            </span>
          </span>
        </button>
        <Toggle
          checked={row.enabled}
          onChange={(next) => onToggleApp(row, next)}
          ariaLabel={t("appSkills.enableApp", { name: row.name })}
        />
      </div>
      {expandable && expanded && (
        <div className="ms-6 mt-2 divide-y divide-border/60 border-t border-border/60 dark:divide-border-subtle/50 dark:border-border-subtle/50">
          {actions.map((action) => (
            <ActionRow
              key={action.id}
              appId={row.appId}
              appEnabled={row.enabled}
              action={action}
              onToggle={(a, enabled) => onToggleAction(row, a, enabled)}
            />
          ))}
        </div>
      )}
    </SettingsPanelRow>
  );
}

export default function AppsSkillsSettings() {
  const { t, i18n } = useTranslation();
  const api = getOverlayAppsApi();
  const scan = useOverlayAppsScan(false);

  const [summary, setSummary] = useState<ScanResult | null>(null);
  const [skills, setSkills] = useState<AppSkill[]>([]);
  const [learned, setLearned] = useState<Learned[]>([]);
  const [loading, setLoading] = useState(Boolean(api));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const bridge = getOverlayAppsApi();
    if (!bridge) return;
    const [summaryResult, skillsResult, learnedResult] = await Promise.allSettled([
      bridge.getSummary(),
      bridge.list(),
      bridge.learnedList(),
    ]);
    if (!mountedRef.current) return;
    if (summaryResult.status === "fulfilled") setSummary(summaryResult.value);
    if (skillsResult.status === "fulfilled") setSkills(skillsResult.value ?? []);
    if (learnedResult.status === "fulfilled") setLearned(learnedResult.value ?? []);
    const failed = [summaryResult, skillsResult, learnedResult].find(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    setLoadError(failed ? errorMessage(failed.reason) || t("appSkills.unknownError") : null);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rescan = async () => {
    const result = await scan.run();
    if (result) {
      setSummary(result);
      await reload();
    }
  };

  const rows = useMemo(() => mergeAppRows(summary, skills), [summary, skills]);
  const visibleRows = useMemo(() => filterAppRows(rows, query), [rows, query]);

  const toggleApp = useCallback(
    async (row: AppRow, enabled: boolean) => {
      const bridge = getOverlayAppsApi();
      if (!bridge) return;
      const apply = (value: boolean) => {
        setSkills((prev) =>
          prev.map((s) => (s.appId === row.appId ? { ...s, enabled: value } : s))
        );
        setSummary((prev) =>
          prev
            ? {
                ...prev,
                apps: prev.apps.map((a) => (a.appId === row.appId ? { ...a, enabled: value } : a)),
              }
            : prev
        );
      };
      apply(enabled);
      setActionError(null);
      try {
        await bridge.setEnabled({ appId: row.appId, enabled });
      } catch (error) {
        logger.warn("Could not change an app's enabled state", { appId: row.appId, error }, "apps");
        if (mountedRef.current) {
          apply(!enabled);
          setActionError(errorMessage(error) || t("appSkills.unknownError"));
        }
      }
    },
    [t]
  );

  const toggleAction = useCallback(
    async (row: AppRow, action: AppSkillAction, enabled: boolean) => {
      const bridge = getOverlayAppsApi();
      if (!bridge) return;
      const apply = (value: boolean) =>
        setSkills((prev) =>
          prev.map((s) =>
            s.appId === row.appId
              ? {
                  ...s,
                  actions: s.actions.map((a) =>
                    a.id === action.id ? { ...a, enabled: value } : a
                  ),
                }
              : s
          )
        );
      apply(enabled);
      setActionError(null);
      try {
        await bridge.setEnabled({ appId: row.appId, actionId: action.id, enabled });
      } catch (error) {
        logger.warn(
          "Could not change an action's enabled state",
          { appId: row.appId, actionId: action.id, error },
          "apps"
        );
        if (mountedRef.current) {
          apply(!enabled);
          setActionError(errorMessage(error) || t("appSkills.unknownError"));
        }
      }
    },
    [t]
  );

  const deleteLearned = useCallback(
    async (item: Learned) => {
      const bridge = getOverlayAppsApi();
      if (!bridge) return;
      setActionError(null);
      try {
        await bridge.learnedDelete(item.id);
        if (mountedRef.current) setLearned((prev) => prev.filter((l) => l.id !== item.id));
      } catch (error) {
        logger.warn("Could not delete a learned command", { id: item.id, error }, "apps");
        if (mountedRef.current) setActionError(errorMessage(error) || t("appSkills.unknownError"));
      }
    },
    [t]
  );

  const appNameById = useMemo(() => new Map(rows.map((r) => [r.appId, r.name])), [rows]);

  if (!api) {
    return (
      <div>
        <SectionHeader
          title={t("appSkills.title")}
          description={t("appSkills.settings.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <p className="text-xs text-muted-foreground/80">{t("appSkills.notAvailable")}</p>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    );
  }

  const scanning = scan.status === "scanning";
  const lastScan = formatDateTime(summary?.scannedAt, i18n.language);

  return (
    <div className="space-y-6">
      <div>
        <SectionHeader
          title={t("appSkills.title")}
          description={t("appSkills.settings.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("appSkills.lastScan")}
              description={lastScan ?? t("appSkills.neverScanned")}
            >
              <Button variant="outline" size="sm" disabled={scanning} onClick={() => void rescan()}>
                {scanning ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                )}
                {scanning ? t("appSkills.scanning") : t("appSkills.rescan")}
              </Button>
            </SettingsRow>
            {scanning && (
              <div className="mt-3">
                <AppScanProgress progress={scan.progress} />
              </div>
            )}
            {scan.status === "error" && (
              <p role="alert" dir="auto" className="mt-2 text-xs text-destructive">
                {t("appSkills.scanFailed")}
                {scan.error ? ` ${scan.error}` : ""}
              </p>
            )}
          </SettingsPanelRow>

          {summary && (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground/80">
                {t("appSkills.onboarding.summary", {
                  found: summary.found,
                  withCommands: summary.withCommands,
                })}
              </p>
            </SettingsPanelRow>
          )}

          <SettingsPanelRow>
            <div className="relative">
              <Search
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
                aria-hidden="true"
              />
              <Input
                dir="auto"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("appSkills.searchPlaceholder")}
                aria-label={t("appSkills.searchPlaceholder")}
                className="h-9 ps-9 text-xs"
              />
            </div>
          </SettingsPanelRow>

          {loadError && (
            <SettingsPanelRow>
              <p role="alert" dir="auto" className="text-xs text-destructive">
                {t("appSkills.loadFailed")} {loadError}
              </p>
            </SettingsPanelRow>
          )}
          {actionError && (
            <SettingsPanelRow>
              <p role="alert" dir="auto" className="text-xs text-destructive">
                {actionError}
              </p>
            </SettingsPanelRow>
          )}
        </SettingsPanel>

        <SettingsPanel className="mt-3 max-h-[28rem] overflow-y-auto">
          {loading ? (
            <SettingsPanelRow>
              <p className="flex items-center gap-2 text-xs text-muted-foreground/80">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("common.loading")}
              </p>
            </SettingsPanelRow>
          ) : visibleRows.length === 0 ? (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground/80">
                {rows.length === 0 ? t("appSkills.noScanYet") : t("appSkills.noAppsFound")}
              </p>
            </SettingsPanelRow>
          ) : (
            visibleRows.map((row) => (
              <AppRowItem
                key={row.appId}
                row={row}
                expanded={expandedId === row.appId}
                onExpand={() => setExpandedId((prev) => (prev === row.appId ? null : row.appId))}
                onToggleApp={(r, enabled) => void toggleApp(r, enabled)}
                onToggleAction={(r, action, enabled) => void toggleAction(r, action, enabled)}
              />
            ))
          )}
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader
          title={t("appSkills.learned.title")}
          description={t("appSkills.learned.description")}
        />
        <SettingsPanel>
          {learned.length === 0 ? (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground/80">{t("appSkills.learned.empty")}</p>
            </SettingsPanelRow>
          ) : (
            learned.map((item) => {
              const when = formatDateTime(item.timestamp, i18n.language);
              const appName = appNameById.get(item.appId) ?? item.appId;
              return (
                <SettingsPanelRow key={item.id}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="break-words text-xs font-medium text-foreground">
                        {item.utterance}
                      </p>
                      <p dir="auto" className="mt-0.5 text-xs text-muted-foreground/80">
                        {[appName, when].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void deleteLearned(item)}
                      aria-label={t("appSkills.learned.deleteLabel", { utterance: item.utterance })}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      {t("common.delete")}
                    </Button>
                  </div>
                </SettingsPanelRow>
              );
            })
          )}
        </SettingsPanel>
      </div>
    </div>
  );
}

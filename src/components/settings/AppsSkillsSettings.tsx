import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "../icons";
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

function AddAppForm({
  availableApps,
  onAppAdded,
}: {
  availableApps: AppRow[];
  onAppAdded: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [targetType, setTargetType] = useState<"installed" | "url" | "uri" | "command">("installed");
  const [selectedAppId, setSelectedAppId] = useState("");
  const [customTarget, setCustomTarget] = useState("");
  const [actionId, setActionId] = useState("launch");
  const [actionDesc, setActionDesc] = useState("");
  const [paramName, setParamName] = useState("");
  const [risk, setRisk] = useState<"safe" | "confirm">("safe");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const handleSelectApp = (appId: string) => {
    setSelectedAppId(appId);
    const found = availableApps.find((a) => a.appId === appId);
    if (found) {
      if (!name) setName(found.name);
      if (!actionDesc) setActionDesc(`Open ${found.name}`);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const api = getOverlayAppsApi();
    if (!api) return;

    if (!name.trim()) {
      setFeedback({ type: "error", message: `${t("appSkills.custom.appName")} is required` });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
      const current = await api.customGet();
      let parsed: { version?: number; apps?: any[] } = { version: 1, apps: [] };
      try {
        parsed = JSON.parse(current.text);
      } catch {
        parsed = { version: 1, apps: [] };
      }
      if (!Array.isArray(parsed.apps)) parsed.apps = [];

      let howType = "cli";
      let howTemplate = "";
      if (targetType === "installed") {
        const found = availableApps.find((a) => a.appId === selectedAppId);
        if (found?.skill?.target) {
          howType = found.skill.kind === "web" ? "uri" : "cli";
          howTemplate = found.skill.target;
        } else if (found?.source) {
          howTemplate = found.name;
        } else {
          howTemplate = customTarget.trim() || name.trim();
        }
      } else if (targetType === "url" || targetType === "uri") {
        howType = "uri";
        howTemplate = customTarget.trim();
      } else {
        howType = "cli";
        howTemplate = customTarget.trim();
      }

      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "custom-app";

      const params = paramName.trim()
        ? [{ name: paramName.trim(), type: "string", required: false }]
        : [];

      const newApp = {
        appId: slug,
        name: name.trim(),
        aliases: aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
        enabled: true,
        actions: [
          {
            id: actionId.trim() || "launch",
            description: actionDesc.trim() || `Open ${name.trim()}`,
            params,
            how: { type: howType, template: howTemplate },
            examples: [{ utterance: `open ${name.trim().toLowerCase()}`, params: {} }],
            risk,
            enabled: true,
          },
        ],
      };

      const existingIdx = parsed.apps.findIndex((a: any) => a.appId === slug);
      if (existingIdx >= 0) {
        parsed.apps[existingIdx] = newApp;
      } else {
        parsed.apps.push(newApp);
      }

      const saveRes = await api.customSave(JSON.stringify(parsed, null, 2));
      if (!saveRes.ok && saveRes.errors?.length) {
        setFeedback({ type: "error", message: saveRes.errors.join(", ") });
      } else {
        setFeedback({ type: "success", message: t("appSkills.custom.appAddedSuccess") });
        setName("");
        setAliases("");
        setCustomTarget("");
        setActionDesc("");
        setParamName("");
        onAppAdded();
      }
    } catch (err: any) {
      setFeedback({ type: "error", message: err.message || t("appSkills.unknownError") });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleAdd(e)} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">{t("appSkills.custom.appName")}</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("appSkills.custom.appNamePlaceholder")}
            className="h-8 text-xs"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">{t("appSkills.custom.appAliases")}</label>
          <Input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={t("appSkills.custom.appAliasesPlaceholder")}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">{t("appSkills.custom.targetType")}</label>
          <select
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as any)}
            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="installed">{t("appSkills.custom.targetInstalled")}</option>
            <option value="url">{t("appSkills.custom.targetUrl")}</option>
            <option value="uri">{t("appSkills.custom.targetUri")}</option>
            <option value="command">{t("appSkills.custom.targetCommand")}</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">
            {targetType === "installed" ? t("appSkills.custom.targetInstalled") : t("appSkills.custom.actionTemplate")}
          </label>
          {targetType === "installed" ? (
            <select
              value={selectedAppId}
              onChange={(e) => handleSelectApp(e.target.value)}
              className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">{t("appSkills.custom.selectInstalledApp")}</option>
              {availableApps.map((a) => (
                <option key={a.appId} value={a.appId}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={customTarget}
              onChange={(e) => setCustomTarget(e.target.value)}
              placeholder={
                targetType === "url"
                  ? "https://example.com"
                  : targetType === "uri"
                    ? "spotify:album:..."
                    : "mytool.exe {file}"
              }
              className="h-8 text-xs font-mono"
              required
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">{t("appSkills.custom.actionName")}</label>
          <Input
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
            placeholder={t("appSkills.custom.actionNamePlaceholder")}
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">{t("appSkills.custom.actionDescription")}</label>
          <Input
            value={actionDesc}
            onChange={(e) => setActionDesc(e.target.value)}
            placeholder={t("appSkills.custom.actionDescriptionPlaceholder")}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">{t("appSkills.custom.risk")}</label>
          <select
            value={risk}
            onChange={(e) => setRisk(e.target.value as any)}
            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="safe">{t("appSkills.custom.riskSafe")}</option>
            <option value="confirm">{t("appSkills.custom.riskConfirm")}</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-foreground">{t("appSkills.custom.paramName")}</label>
        <Input
          value={paramName}
          onChange={(e) => setParamName(e.target.value)}
          placeholder={t("appSkills.custom.paramNamePlaceholder")}
          className="h-8 text-xs font-mono"
        />
      </div>

      {feedback && (
        <div
          role="alert"
          className={`flex items-center gap-2 rounded-md p-2 text-xs ${
            feedback.type === "success"
              ? "bg-success/10 text-success"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {feedback.type === "success" ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <AlertCircle className="size-3.5" aria-hidden="true" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      <div className="flex justify-end pt-1">
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="size-3.5" aria-hidden="true" />
          )}
          {t("appSkills.custom.addAppButton")}
        </Button>
      </div>
    </form>
  );
}

function CustomJsonEditor({
  editorKey,
  onSaved,
}: {
  editorKey: number;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "valid" | "saved">("idle");
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    const api = getOverlayAppsApi();
    if (!api) return;
    try {
      const res = await api.customGet();
      setText(res.text || "");
      setPath(res.path || "");
      setErrors(res.errors || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData, editorKey]);

  const handleScroll = () => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleValidate = async () => {
    const api = getOverlayAppsApi();
    if (!api) return;
    setValidating(true);
    setStatus("idle");
    try {
      const res = await api.customValidate(text);
      setErrors(res.errors || []);
      if (res.ok) setStatus("valid");
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    const api = getOverlayAppsApi();
    if (!api) return;
    setSaving(true);
    setStatus("idle");
    try {
      const res = await api.customSave(text);
      setErrors(res.errors || []);
      if (res.ok) {
        setStatus("saved");
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleOpenFile = async () => {
    const api = getOverlayAppsApi();
    if (!api) return;
    await api.customOpenFile();
  };

  const handleReset = async () => {
    const api = getOverlayAppsApi();
    if (!api) return;
    const res = await api.customGet();
    setText(res.text || "");
    setErrors([]);
    setStatus("idle");
  };

  const jumpToLine = (errText: string) => {
    let targetLine = 1;
    const lineMatch = errText.match(/(?:line|Line)\s+(\d+)/);
    if (lineMatch) {
      targetLine = parseInt(lineMatch[1], 10);
    } else {
      const appMatch = errText.match(/App\s+#(\d+)/i);
      if (appMatch) {
        const appIdx = parseInt(appMatch[1], 10);
        let count = 0;
        const allLines = text.split("\n");
        for (let l = 0; l < allLines.length; l++) {
          if (allLines[l].includes('"appId"')) {
            count++;
            if (count === appIdx) {
              targetLine = l + 1;
              break;
            }
          }
        }
      }
    }
    if (!textareaRef.current) return;
    const lines = text.split("\n");
    let charPos = 0;
    for (let i = 0; i < Math.min(targetLine - 1, lines.length); i++) {
      charPos += lines[i].length + 1;
    }
    textareaRef.current.focus();
    const endPos = charPos + (lines[targetLine - 1]?.length || 0);
    textareaRef.current.setSelectionRange(charPos, endPos);
    textareaRef.current.scrollTop = Math.max(0, (targetLine - 3) * 20);
  };

  const lines = text.split("\n");
  const lineCount = Math.max(1, lines.length);

  return (
    <div className="space-y-3">
      {path && (
        <p dir="auto" className="font-mono text-[11px] text-muted-foreground/70 truncate">
          {path}
        </p>
      )}

      <div className="flex rounded-md border border-border bg-muted/10 dark:bg-surface-2 overflow-hidden focus-within:ring-1 focus-within:ring-ring">
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="w-10 select-none overflow-hidden border-e border-border/60 bg-muted/30 py-2 pe-2 text-end font-mono text-xs leading-5 text-muted-foreground/40"
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i + 1} className="h-5 leading-5">
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setStatus("idle");
          }}
          onScroll={handleScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={16}
          className="flex-1 resize-y bg-transparent p-2 font-mono text-xs leading-5 text-foreground outline-none whitespace-pre min-h-[16rem]"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {status === "valid" && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" aria-hidden="true" />
              {t("appSkills.custom.valid")}
            </span>
          )}
          {status === "saved" && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" aria-hidden="true" />
              {t("appSkills.custom.saved")}
            </span>
          )}
          {errors.length > 0 && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertCircle className="size-3.5" aria-hidden="true" />
              {t("appSkills.custom.errorsFound", { count: errors.length })}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleReset()}>
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t("appSkills.custom.resetTemplate")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleOpenFile()}>
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {t("appSkills.custom.openFile")}
          </Button>
          <Button variant="outline" size="sm" disabled={validating} onClick={() => void handleValidate()}>
            {validating ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="size-3.5" aria-hidden="true" />
            )}
            {t("appSkills.custom.validate")}
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-3.5" aria-hidden="true" />
            )}
            {t("appSkills.custom.save")}
          </Button>
        </div>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive space-y-1"
        >
          <p className="font-medium">
            {t("appSkills.custom.errorsFound", { count: errors.length })}:
          </p>
          <ul className="list-disc ps-4 space-y-0.5">
            {errors.map((err, i) => (
              <li key={i} className="break-words">
                <button
                  type="button"
                  onClick={() => jumpToLine(err)}
                  className="text-start hover:underline focus:outline-none"
                >
                  {err}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
  const [customEditorKey, setCustomEditorKey] = useState(0);
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
          title={t("appSkills.custom.title")}
          description={t("appSkills.custom.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-3">
              <div>
                <h4 className="text-xs font-medium text-foreground">
                  {t("appSkills.custom.addAppTitle")}
                </h4>
                <p className="text-xs text-muted-foreground/80">
                  {t("appSkills.custom.addAppDescription")}
                </p>
              </div>
              <AddAppForm
                availableApps={rows}
                onAppAdded={() => {
                  void reload();
                  setCustomEditorKey((k) => k + 1);
                }}
              />
            </div>
          </SettingsPanelRow>

          <SettingsPanelRow>
            <div className="space-y-3">
              <div>
                <h4 className="text-xs font-medium text-foreground">
                  {t("appSkills.custom.editorTitle")}
                </h4>
                <p className="text-xs text-muted-foreground/80">
                  {t("appSkills.custom.editorDescription")}
                </p>
              </div>
              <CustomJsonEditor
                editorKey={customEditorKey}
                onSaved={() => {
                  void reload();
                }}
              />
            </div>
          </SettingsPanelRow>
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

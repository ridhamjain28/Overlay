import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "../icons";
import { OVERLAY_DEFAULT_MODEL, useSettingsStore } from "../../stores/settingsStore";
import { Button } from "../ui/button";

// Overlay: "what this PC still needs" checklist. Used as the last onboarding
// step and in Settings. Every install runs hidden in the main process; this
// view only shows the result and the log.

export interface RequirementItem {
  id: string;
  label: string;
  optional: boolean;
  status: "ok" | "missing" | "stopped";
  detail: string;
  command: string | null;
  actionLabel: string | null;
  blockedBy?: string | null;
}

const HINGLISH_CHOICE_KEY = "overlayHinglishChoice";
const DEFAULT_ANSWER_MODEL = OVERLAY_DEFAULT_MODEL;
const HINGLISH_ORDER = ["python", "hinglish-libs", "hinglish-model"];
const MAX_LOG_LINES = 300;

type HinglishChoice = "download" | "standard" | null;

function readChoice(): HinglishChoice {
  try {
    const v = localStorage.getItem(HINGLISH_CHOICE_KEY);
    return v === "download" || v === "standard" ? v : null;
  } catch {
    return null;
  }
}

function StatusIcon({ status, busy }: { status: RequirementItem["status"]; busy: boolean }) {
  if (busy) return <Loader2 className="h-4 w-4 animate-spin text-primary" aria-label="Working" />;
  if (status === "ok")
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-3.5 w-3.5 text-emerald-500" aria-label="Ready" />
      </span>
    );
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-destructive/15">
      <X className="h-3.5 w-3.5 text-destructive" aria-label="Missing" />
    </span>
  );
}

export default function RequirementsChecklist({ compact = false }: { compact?: boolean }) {
  const spokenLanguages = useSettingsStore((s) => s.spokenLanguages);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const whisperModel = useSettingsStore((s) => s.whisperModel);
  const useLocalWhisper = useSettingsStore((s) => s.useLocalWhisper);
  const chatAgentMode = useSettingsStore((s) => s.chatAgentMode);
  const chatAgentModel = useSettingsStore((s) => s.chatAgentModel);
  const overlayModelAutoSelect = useSettingsStore((s) => s.overlayModelAutoSelect);
  const [recommendedModel, setRecommendedModel] = useState<string | null>(null);

  const hindiSelected = ["hi", "hi-Latn"].some(
    (code) => spokenLanguages.includes(code) || preferredLanguage === code
  );
  const [choice, setChoice] = useState<HinglishChoice>(readChoice);
  const includeHinglish = hindiSelected && choice === "download";
  const configuredModel =
    chatAgentMode === "self-hosted" && chatAgentModel ? chatAgentModel : DEFAULT_ANSWER_MODEL;
  const answerModel =
    overlayModelAutoSelect && recommendedModel ? recommendedModel : configuredModel;

  const [items, setItems] = useState<RequirementItem[]>([]);
  const [checking, setChecking] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  const autoRunRef = useRef(false);
  const api = window.electronAPI;

  useEffect(() => {
    if (!overlayModelAutoSelect) {
      setRecommendedModel(null);
      return;
    }
    let cancelled = false;
    void api
      ?.overlayRecommendModel?.({ current: configuredModel, autoSelect: true })
      .then((result) => {
        if (!cancelled && result?.recommendedPull) setRecommendedModel(result.recommendedPull);
      });
    return () => {
      cancelled = true;
    };
  }, [api, overlayModelAutoSelect, configuredModel]);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => {
      const next = prev.length >= MAX_LOG_LINES ? prev.slice(-MAX_LOG_LINES + 1) : prev.slice();
      next.push(line);
      return next;
    });
  }, []);

  const recheck = useCallback(async (): Promise<RequirementItem[]> => {
    setChecking(true);
    try {
      const result = (await api?.overlayRequirementsCheck?.({ includeHinglish, answerModel })) ?? {
        items: [],
      };
      const list: RequirementItem[] = [...(result.items || [])];
      if (useLocalWhisper && api?.listWhisperModels) {
        const models = await api.listWhisperModels().catch(() => null);
        const ready = !!models?.models?.some((m) => m.model === whisperModel && m.downloaded);
        list.unshift({
          id: "whisper-model",
          label: `Dictation model (Whisper ${whisperModel})`,
          optional: false,
          status: ready ? "ok" : "missing",
          detail: ready ? "Downloaded" : "Not downloaded yet",
          command: null,
          actionLabel: ready ? null : "Download",
        });
      }
      setItems(list);
      return list;
    } finally {
      setChecking(false);
    }
  }, [api, includeHinglish, answerModel, useLocalWhisper, whisperModel]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  useEffect(() => {
    return api?.onOverlayRequirementsOutput?.((payload) => {
      if (payload.line) appendLog(payload.line);
      if (typeof payload.progress === "number") setProgress(payload.progress);
    });
  }, [api, appendLog]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const installOne = useCallback(
    async (id: string): Promise<boolean> => {
      setRunning(id);
      setProgress(0);
      setError(null);
      try {
        if (id === "whisper-model") {
          const off = api?.onWhisperDownloadProgress?.((_e, data) => {
            if (typeof data?.percentage === "number") setProgress(Math.round(data.percentage));
          });
          appendLog(`> download Whisper ${whisperModel}`);
          const r = await api?.downloadWhisperModel?.(whisperModel);
          off?.();
          if (!r?.success) throw new Error(r?.error || "Download failed");
          appendLog("Done");
          return true;
        }
        const r = await api?.overlayRequirementsInstall?.(id, { model: answerModel });
        if (!r?.success) throw new Error(r?.error || "Install failed");
        appendLog("Done");
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        appendLog(`Failed: ${message}`);
        return false;
      } finally {
        setRunning(null);
        setProgress(null);
      }
    },
    [api, answerModel, appendLog, whisperModel]
  );

  const install = async (id: string) => {
    await installOne(id);
    await recheck();
  };

  const chooseHinglish = async (value: Exclude<HinglishChoice, null>) => {
    try {
      localStorage.setItem(HINGLISH_CHOICE_KEY, value);
      if (value === "download") localStorage.removeItem("overlayHinglishAutoRan");
    } catch {}
    autoRunRef.current = false;
    setChoice(value);
  };

  // After "Download now", run the missing Hinglish pieces one after another.
  useEffect(() => {
    if (!includeHinglish || autoRunRef.current || checking || running) return;
    const pending = HINGLISH_ORDER.map((id) => items.find((i) => i.id === id)).filter(
      (i): i is RequirementItem => !!i && i.status !== "ok"
    );
    if (pending.length === 0 || localStorage.getItem("overlayHinglishAutoRan") === "1") return;
    autoRunRef.current = true;
    try {
      localStorage.setItem("overlayHinglishAutoRan", "1");
    } catch {}
    void (async () => {
      for (const id of HINGLISH_ORDER) {
        const latest = await recheck();
        const item = latest.find((i) => i.id === id);
        if (!item || item.status === "ok") continue;
        if (!(await installOne(id))) break;
      }
      await recheck();
    })();
  }, [includeHinglish, items, checking, running, installOne, recheck]);

  const missing = items.filter((i) => i.status !== "ok");
  const allGood = !checking && items.length > 0 && missing.length === 0;

  return (
    <div className={`flex w-full flex-col gap-3 ${compact ? "" : "max-w-xl"}`}>
      {hindiSelected && choice === null && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
          <p className="text-foreground">
            For better Hindi in Roman letters (Hinglish), download the Hinglish speech model (about
            1 GB). Download now, or use standard Whisper.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void chooseHinglish("download")}>
              Download now
            </Button>
            <Button size="sm" variant="outline" onClick={() => void chooseHinglish("standard")}>
              Use standard Whisper
            </Button>
          </div>
        </div>
      )}

      {hindiSelected && choice === "standard" && !compact && (
        <button
          type="button"
          className="self-start text-xs text-primary underline-offset-2 hover:underline"
          onClick={() => void chooseHinglish("download")}
        >
          Add the Hinglish speech model (better Hindi in Roman letters)
        </button>
      )}

      <ul className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card/40">
        {items.map((item) => {
          const blocked =
            !!item.blockedBy && items.some((i) => i.id === item.blockedBy && i.status !== "ok");
          return (
            <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="pt-0.5">
                <StatusIcon status={item.status} busy={running === item.id} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  {item.label}
                  {item.optional && (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                      optional
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{item.detail}</div>
                {item.status !== "ok" && item.command && (
                  <code className="mt-1 block select-all break-all rounded-md bg-muted/70 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {item.command}
                  </code>
                )}
              </div>
              {item.status !== "ok" && item.actionLabel && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!running || blocked}
                  onClick={() => void install(item.id)}
                >
                  {item.actionLabel}
                </Button>
              )}
            </li>
          );
        })}
        {checking && items.length === 0 && (
          <li className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking this PC...
          </li>
        )}
      </ul>

      {running && progress !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.max(3, Math.min(100, progress))}%` }}
          />
        </div>
      )}

      {log.length > 0 && (
        <pre
          ref={logRef}
          className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/40 p-2 font-mono text-[11px] leading-snug text-muted-foreground"
        >
          {log.join("\n")}
        </pre>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {allGood
            ? "Everything is ready."
            : error
              ? `Last install failed: ${error}`
              : missing.length > 0
                ? "Overlay still works without the missing items; you can install them later in Settings."
                : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={checking || !!running}
          onClick={() => void recheck()}
        >
          {checking ? "Checking..." : "Check again"}
        </Button>
      </div>
    </div>
  );
}

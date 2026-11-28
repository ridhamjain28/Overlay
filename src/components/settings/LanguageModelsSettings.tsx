import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Cpu, Network, RefreshCw } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAiProvider, type AiProviderKind } from "../../stores/aiProvider";
import { cn } from "../lib/utils";

const KIND_OPTIONS: {
  id: AiProviderKind;
  icon: React.ComponentType<{ className?: string }>;
  labelKey: string;
  descriptionKey: string;
}[] = [
  {
    id: "local",
    icon: Cpu,
    labelKey: "simpleSettings.llm.kinds.local",
    descriptionKey: "simpleSettings.llm.kinds.localDescription",
  },
  {
    id: "own-server",
    icon: Network,
    labelKey: "simpleSettings.llm.kinds.ownServer",
    descriptionKey: "simpleSettings.llm.kinds.ownServerDescription",
  },
  {
    id: "cloud",
    icon: Cloud,
    labelKey: "simpleSettings.llm.kinds.cloud",
    descriptionKey: "simpleSettings.llm.kinds.cloudDescription",
  },
];

function LocalModelPicker() {
  const { t } = useTranslation();
  const model = useAiProvider((s) => s.model);
  const update = useAiProvider((s) => s.update);
  const autoSelect = useSettingsStore((s) => s.overlayModelAutoSelect);
  const setAutoSelect = useSettingsStore((s) => s.setOverlayModelAutoSelect);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setUnreachable(false);
    try {
      const list = await window.electronAPI?.overlayOllamaModels?.();
      if (!mountedRef.current) return;
      if (Array.isArray(list)) {
        setInstalled(list);
        setUnreachable(false);
      } else {
        setInstalled(null);
        setUnreachable(true);
      }
    } catch {
      if (!mountedRef.current) return;
      setInstalled(null);
      setUnreachable(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = (value: string) => {
    // A manual pick turns hardware auto-select off; set it first so the write keeps it off.
    setAutoSelect(false);
    update({ model: value });
  };

  const options = Array.from(new Set([...(installed ?? []), ...(model ? [model] : [])]));

  const modelStatusDescription = loading ? (
    <span role="status" aria-live="polite">
      {t("common.loading")}
    </span>
  ) : unreachable ? (
    <span role="status" aria-live="polite" className="text-amber-600 dark:text-amber-400">
      {t("simpleSettings.llm.ollamaUnreachable", {
        defaultValue: "Couldn't reach Ollama. Make sure it's running, then refresh.",
      })}
    </span>
  ) : installed && installed.length === 0 ? (
    <span role="status" aria-live="polite">
      {t("simpleSettings.llm.noLocalModels")}
    </span>
  ) : undefined;

  return (
    <>
      <SettingsPanelRow>
        <SettingsRow
          label={t("simpleSettings.llm.autoSelect")}
          description={t("simpleSettings.llm.autoSelectDescription")}
        >
          <Toggle
            checked={autoSelect}
            ariaLabel={t("simpleSettings.llm.autoSelect")}
            onChange={(checked: boolean) => {
              setAutoSelect(checked);
              if (checked) {
                // Re-run the recommendation now instead of waiting for the next launch.
                void window.electronAPI
                  ?.overlayRecommendModel?.({
                    installed: installed ?? undefined,
                    current: model,
                    autoSelect: true,
                  })
                  .then((rec: { model?: string | null } | undefined) => {
                    if (rec?.model) update({ model: rec.model });
                  })
                  .catch(() => {});
              }
            }}
          />
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <SettingsRow
          label={t("simpleSettings.llm.model")}
          description={modelStatusDescription}
        >
          <div className="flex items-center gap-2">
            <select
              data-testid="ai-local-model"
              aria-label={t("simpleSettings.llm.model")}
              value={model}
              disabled={autoSelect}
              onChange={(e) => choose(e.target.value)}
              className="h-7 max-w-[240px] rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
            >
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="ai-local-models-refresh"
              aria-label={t("common.refresh")}
              title={t("common.refresh")}
              aria-busy={loading}
              disabled={loading}
              onClick={() => void refresh()}
              className="h-7 px-2.5"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
              <span>{t("common.refresh")}</span>
            </Button>
          </div>
        </SettingsRow>
      </SettingsPanelRow>
    </>
  );
}

function OwnServerFields() {
  const { t } = useTranslation();
  const serverUrl = useAiProvider((s) => s.serverUrl);
  const model = useAiProvider((s) => s.model);
  const apiKey = useAiProvider((s) => s.apiKey);
  const update = useAiProvider((s) => s.update);
  const setApiKey = useAiProvider((s) => s.setApiKey);
  const setAutoSelect = useSettingsStore((s) => s.setOverlayModelAutoSelect);
  return (
    <>
      <SettingsPanelRow>
        <SettingsRow
          label={t("simpleSettings.llm.serverUrl")}
          description={t("simpleSettings.llm.serverUrlDescription")}
        >
          <Input
            aria-label={t("simpleSettings.llm.serverUrl")}
            value={serverUrl}
            onChange={(e) => update({ serverUrl: e.target.value })}
            placeholder="http://192.168.1.20:8080/v1"
            spellCheck={false}
            className="h-8 w-[260px] text-xs"
          />
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <SettingsRow label={t("simpleSettings.llm.model")}>
          <Input
            aria-label={t("simpleSettings.llm.model")}
            value={model}
            onChange={(e) => {
              setAutoSelect(false);
              update({ model: e.target.value });
            }}
            spellCheck={false}
            className="h-8 w-[260px] text-xs"
          />
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <SettingsRow
          label={t("simpleSettings.llm.apiKeyOptional")}
          description={t("simpleSettings.llm.apiKeyDescription")}
        >
          <Input
            aria-label={t("simpleSettings.llm.apiKeyOptional")}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            spellCheck={false}
            className="h-8 w-[260px] text-xs"
          />
        </SettingsRow>
      </SettingsPanelRow>
    </>
  );
}

function CloudFields() {
  const model = useAiProvider((s) => s.model);
  const cloudProvider = useAiProvider((s) => s.cloudProvider);
  const cloudBaseUrl = useAiProvider((s) => s.cloudBaseUrl);
  const apiKey = useAiProvider((s) => s.apiKey);
  const update = useAiProvider((s) => s.update);
  const setApiKey = useAiProvider((s) => s.setApiKey);
  return (
    <SettingsPanelRow>
      <ReasoningModelSelector
        reasoningModel={model}
        setReasoningModel={(value) => update({ model: value })}
        localReasoningProvider={cloudProvider}
        setLocalReasoningProvider={(value) => update({ cloudProvider: value })}
        cloudReasoningBaseUrl={cloudBaseUrl}
        setCloudReasoningBaseUrl={(value) => update({ cloudBaseUrl: value })}
        customReasoningApiKey={apiKey}
        setCustomReasoningApiKey={setApiKey}
        mode="cloud"
      />
    </SettingsPanelRow>
  );
}

export default function LanguageModelsSettings() {
  const { t } = useTranslation();
  const kind = useAiProvider((s) => s.kind);
  const selectKind = useAiProvider((s) => s.selectKind);
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKindKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const nextIndex = (index + step + KIND_OPTIONS.length) % KIND_OPTIONS.length;
    const next = KIND_OPTIONS[nextIndex];
    selectKind(next.id);
    radioRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="space-y-6">
      <div>
        <SectionHeader
          title={t("simpleSettings.llm.title")}
          description={t("simpleSettings.llm.description")}
        />
        <div className="grid gap-2" role="radiogroup" aria-label={t("simpleSettings.llm.title")}>
          {KIND_OPTIONS.map((option, index) => {
            const Icon = option.icon;
            const selected = kind === option.id;
            return (
              <button
                key={option.id}
                ref={(el) => {
                  radioRefs.current[index] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`ai-kind-${option.id}`}
                onClick={() => selectKind(option.id)}
                onKeyDown={(e) => handleKindKeyDown(e, index)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  selected
                    ? "border-primary/50 bg-primary/[0.04]"
                    : "border-border/70 hover:bg-muted/40"
                )}
              >
                <Icon
                  className={cn("mt-0.5 h-4 w-4", selected ? "text-primary" : "")}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {t(option.labelKey)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(option.descriptionKey)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <SettingsPanel>
        {kind === "local" && <LocalModelPicker />}
        {kind === "own-server" && <OwnServerFields />}
        {kind === "cloud" && <CloudFields />}
      </SettingsPanel>
      <p className="text-xs text-muted-foreground/80">{t("simpleSettings.llm.oneModelNote")}</p>
    </div>
  );
}

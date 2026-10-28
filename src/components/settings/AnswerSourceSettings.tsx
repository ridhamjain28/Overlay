import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import {
  getAnswerSourcesStatus,
  normalizeAnswerSourceSetting,
  type AnswerSourcesStatus,
} from "../../services/overlay/answerRouter";

// Overlay: choose which source answers, and see which ones are ready.
// Keys/tokens are never shown or edited here: they live in the app's .env
// (OPENCLAW_TOKEN, OLLAMA_API_KEY, TAVILY_API_KEY) or Settings → API Keys (Gemini).

const OPTIONS = [
  {
    value: "auto",
    label: "Auto (recommended)",
    help: "Quick chat on local Ollama; web and actions go to OpenClaw if it is running, then Gemini, then local.",
  },
  {
    value: "local",
    label: "Local Ollama only",
    help: "Private and free. Uses the model set below (default qwen3.5:4b).",
  },
  {
    value: "openclaw",
    label: "OpenClaw gateway",
    help: "Your OpenClaw agent at 127.0.0.1:18789 answers everything. Falls back to local if it is down.",
  },
  {
    value: "gemini",
    label: "Gemini + Google Search",
    help: "Gemini answers with Google Search grounding. Needs a GEMINI_API_KEY.",
  },
];

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
    />
  );
}

export default function AnswerSourceSettings() {
  const answerSource = useSettingsStore((s) => s.answerSource);
  const setAnswerSource = useSettingsStore((s) => s.setAnswerSource);
  const value = normalizeAnswerSourceSetting(answerSource);
  const [status, setStatus] = useState<AnswerSourcesStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = async () => {
    setChecking(true);
    setStatus(await getAnswerSourcesStatus(true));
    setChecking(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];
  const ollama = status?.ollamaSearch;

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow label="Answer source" description={current.help}>
          <Select value={value} onValueChange={(v) => setAnswerSource(v)}>
            <SelectTrigger className="h-7 w-52 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <div className="flex w-full items-start justify-between gap-3 text-xs text-muted-foreground">
          <ul className="space-y-1">
            <li className="flex items-center gap-2">
              <Dot ok={!!status?.openclaw?.reachable} />
              OpenClaw:{" "}
              {!status?.openclaw?.configured
                ? "not set up (OPENCLAW_TOKEN)"
                : status.openclaw.unauthorized
                  ? "token rejected"
                  : status.openclaw.reachable
                    ? "running"
                    : "not reachable"}
            </li>
            <li className="flex items-center gap-2">
              <Dot ok={!!ollama?.configured} />
              Ollama web search:{" "}
              {ollama?.configured
                ? `ready · ${ollama.usedToday}/${ollama.dailyCap} searches today`
                : "not set up (OLLAMA_API_KEY)"}
            </li>
            <li className="flex items-center gap-2">
              <Dot ok={!!status?.gemini?.configured} />
              Gemini + Google Search:{" "}
              {status?.gemini?.configured ? "ready" : "not set up (GEMINI_API_KEY)"}
            </li>
            <li className="flex items-center gap-2">
              <Dot ok={!!status?.tavily?.configured} />
              Tavily search: {status?.tavily?.configured ? "ready" : "optional (TAVILY_API_KEY)"}
            </li>
          </ul>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

interface AssistantEmptyStateProps {
  disabled?: boolean;
  commandModeEnabled?: boolean;
  onSelectSuggestion: (suggestion: string) => void;
}

const SUGGESTION_KEYS = [
  "assistant.panel.suggestions.summarizeNotes",
  "assistant.panel.suggestions.calendar",
  "assistant.panel.suggestions.draft",
] as const;

const COMMAND_SUGGESTION_KEYS = [
  "assistant.panel.suggestions.screenshot",
  "assistant.panel.suggestions.volume",
  "assistant.panel.suggestions.timer",
] as const;

export function AssistantEmptyState({
  disabled = false,
  commandModeEnabled = false,
  onSelectSuggestion,
}: AssistantEmptyStateProps): ReactElement {
  const { t } = useTranslation();
  const keys = commandModeEnabled
    ? [...SUGGESTION_KEYS, ...COMMAND_SUGGESTION_KEYS]
    : [...SUGGESTION_KEYS];

  return (
    <div className="flex h-full items-end" data-assistant-empty-state>
      <div className="flex w-full flex-wrap gap-2">
        {keys.map((key) => {
          const suggestion = t(key);
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              className="rounded-full border border-border/55 bg-foreground/[0.035] px-3 py-1.5 text-start text-xs text-foreground/70 transition-colors hover:border-border hover:bg-foreground/[0.07] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onSelectSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          );
        })}
      </div>
    </div>
  );
}

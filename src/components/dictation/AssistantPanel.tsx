import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Plus, X } from "../icons";
import {
  getTtsSpeakingState,
  playEarcon,
  speakAssistantText,
  stopAssistantTts,
  subscribeTtsSpeaking,
} from "../../helpers/assistantTtsPlayback";
import { BrandMarkIcon } from "./BrandMarkIcon";
import { HelpEvidence } from "../chat/GroundedHelpEvidence";
import { extractHelpEvidence } from "../chat/helpEvidence";
import { helpAnswerPlainText } from "../chat/helpEvidenceText";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { TechnicalErrorDetails } from "../ui/TechnicalErrorDetails";
import { openProviderSettings } from "../../utils/describeProviderError";
import { Button } from "../ui/button";
import { useChatPersistence } from "../chat/useChatPersistence";
import { useChatStreaming } from "../chat/useChatStreaming";
import { useChatMessageSender } from "../chat/useChatMessageSender";
import { ChatInput } from "../chat/ChatInput";
import { useWindowDrag } from "../../hooks/useWindowDrag";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyListLabel } from "../../utils/hotkeys";
import {
  ASSISTANT_FOOTER_TRANSITION_TIMING,
  resolveAssistantFooterPresentation,
  resolveAssistantResponseReady,
} from "../../helpers/voicePillPresentation";
import {
  AGENT_TOOL_ACTIVITY_ROTATION_MS,
  AGENT_TOOL_ACTIVITY_VERB_KEYS,
  AGENT_TOOL_NAME_FALLBACK_KEY,
} from "../../helpers/agentToolPresentation";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import type { AgentState, ChatImageAttachment, Message } from "../chat/types";
import {
  normalizeAgentSelectionContext,
  type AgentSelectionContext,
} from "../../utils/agentSelectionContext";
import {
  getSelectionForCopyShortcut,
  getSelectionInside,
  isEditableTarget,
} from "../../utils/assistantSelection";
import { AssistantEmptyState } from "./AssistantEmptyState";
import { useToast } from "../ui/useToast";
import {
  resolveAssistantPanelBusy,
  restoreAssistantConversation,
} from "../../helpers/assistantSessionState";
import {
  deliverAssistantResponse,
  type AssistantResponseDelivery,
} from "../../helpers/assistantResponseDelivery";
import { buildAssistantCommandSendOptions } from "./assistantCommandOptions";
import { runCommandOrchestrator } from "../../services/overlay/runCommandMode";
import { resolveCommandParsing, useAiProvider } from "../../stores/aiProvider";
import { commandReferencesSelection } from "../../helpers/overlay/commandMode/typedClause";
import { touchAssistantChatActivity } from "../../helpers/overlay/assistantChatContinuity";
import { ApprovalCard } from "../chat/ApprovalCard";
import { approvalKey, useConnectorApprovalStore } from "../../stores/connectorApprovalStore";

export interface AssistantCommand {
  id: number;
  text: string;
  attachment: ChatImageAttachment | null;
  selectedContext: AgentSelectionContext | null;
  delivery: AssistantResponseDelivery | null;
}

type AssistantFooterPhase =
  "pill" | "pill-entering" | "pill-exiting" | "actions-entering" | "actions" | "actions-exiting";

const MANUAL_COPY_FEEDBACK_MS = 1800;
const AUTO_COPY_FEEDBACK_MS = 6000;

interface AssistantPanelProps {
  /** Voice command waiting to be sent into the conversation (consumed on mount and on change). */
  pendingCommand: AssistantCommand | null;
  onCommandConsumed: (id: number) => void;
  onCommandDiscarded: (id: number) => void;
  onCommandSettled: (id: number, options?: { showPanel?: boolean }) => void;
  /** Conversation to resume when reopening the panel; null starts fresh on first message. */
  initialConversationId: number | null;
  onConversationIdChange: (id: number | null) => void;
  /** Live voice state while the user records a follow-up with the panel open. */
  voiceState: Extract<AgentState, "idle" | "listening" | "transcribing">;
  /** Keeps follow-up thinking feedback inside an already-open panel. */
  thinking: boolean;
  open: boolean;
  footerPhase: AssistantFooterPhase;
  horizontalDirection: "left" | "right";
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onResponseReadyChange: (ready: boolean) => void;
  onResponseContent: () => void;
  onConversationReset: () => void;
  onSelectionContextChange: (context: AgentSelectionContext | null) => void;
}

// Avoid reparsing Markdown when only the selection indicator changes.
const StableAssistantMarkdown = memo(MarkdownRenderer);

export function AssistantPanel({
  pendingCommand,
  onCommandConsumed,
  onCommandDiscarded,
  onCommandSettled,
  initialConversationId,
  onConversationIdChange,
  voiceState,
  thinking,
  open,
  footerPhase,
  horizontalDirection,
  onClose,
  onBusyChange,
  onResponseReadyChange,
  onResponseContent,
  onConversationReset,
  onSelectionContextChange,
}: AssistantPanelProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { handleMouseDown, handleMouseUp } = useWindowDrag();
  const voiceAgentKey = useSettingsStore((state) => state.voiceAgentKey);
  const readableVoiceHotkey = formatHotkeyListLabel(voiceAgentKey);

  const persistence = useChatPersistence({ conversationId: initialConversationId });
  const { messages, setMessages } = persistence;

  const streaming = useChatStreaming({
    messages,
    setMessages,
    // Spoken commands answer on the Voice Assistant scope, not the Chat one.
    inferenceScope: "dictationAgent",
    allowConnectors: true,
    onStreamComplete: (_assistantId, content, toolCalls) => {
      void persistence.saveAssistantMessage(content, toolCalls);
    },
    onResponseContent,
  });

  const createConversation = useCallback(
    (text: string) => {
      const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
      return persistence.createConversation(title);
    },
    [persistence]
  );

  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const sendMessage = useChatMessageSender({
    conversationId: persistence.conversationId,
    persistence,
    streaming,
    createConversation,
    onSendingChange: setSubmissionInFlight,
  });
  const commandModeEnabled = useSettingsStore((s) => s.commandModeEnabled);
  const commandModeAutoRunTrusted = useSettingsStore((s) => s.commandModeAutoRunTrusted);
  const autoSaveCreatedItems = useSettingsStore((s) => s.autoSaveCreatedItems);
  const commandModeParser = useSettingsStore((s) => s.commandModeParser);
  const chatAgentModel = useSettingsStore((s) => s.chatAgentModel);
  const chatAgentRemoteUrl = useSettingsStore((s) => s.chatAgentRemoteUrl);
  const chatAgentProvider = useSettingsStore((s) => s.chatAgentProvider);
  const aiProvider = useAiProvider();
  const commandSettings = useMemo(
    () => ({
      enabled: commandModeEnabled,
      autoRunTrusted: commandModeAutoRunTrusted,
      autoSaveCreatedItems,
      ...resolveCommandParsing(undefined, aiProvider),
    }),
    // The chat/parser settings are inputs of resolveCommandParsing from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      commandModeEnabled,
      commandModeAutoRunTrusted,
      autoSaveCreatedItems,
      commandModeParser,
      chatAgentModel,
      chatAgentRemoteUrl,
      chatAgentProvider,
      aiProvider,
    ]
  );
  const recordCommandTurn = useCallback(
    async (text: string, message: string, promptMessage?: string) => {
      if (persistence.conversationId == null) await createConversation(text);
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        isStreaming: false,
      };
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: message,
        ...(promptMessage ? { promptContent: promptMessage } : {}),
        isStreaming: false,
      };
      persistence.setMessages((messages) => [...messages, userMessage, assistantMessage]);
      await persistence.saveUserMessage(text);
      await persistence.saveAssistantMessage(message, undefined, promptMessage);
      touchAssistantChatActivity();
    },
    [createConversation, persistence]
  );
  const [commandInFlight, setCommandInFlight] = useState(false);
  const [commandProgress, setCommandProgress] = useState<{
    phase?: string;
    current?: number;
    total?: number;
    text?: string;
  } | null>(null);
  useEffect(() => {
    const unsub = window.electronAPI?.onOverlayCommandProgress?.((payload) => {
      const phase = payload?.phase;
      if (!phase || phase === "pasting" || phase === "done") {
        setCommandProgress(null);
        return;
      }
      setCommandProgress({
        phase,
        current: payload.current,
        total: payload.total,
        text: payload.text,
      });
    });
    return () => {
      unsub?.();
    };
  }, []);
  const cancelCommandMode = useCallback(() => {
    setCommandProgress(null);
    void window.electronAPI?.overlayCommandCancel?.();
  }, []);
  const tryCommandMode = useCallback(
    async (text: string): Promise<boolean> => {
      setCommandInFlight(true);
      try {
        const outcome = await runCommandOrchestrator(text, commandSettings);
        if (!outcome.handled) return false;
        playEarcon("success");
        await recordCommandTurn(text, outcome.message, outcome.promptMessage);
        return true;
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          playEarcon("error");
        }
        throw err;
      } finally {
        setCommandInFlight(false);
        setCommandProgress(null);
      }
    },
    [commandSettings, recordCommandTurn]
  );
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const responseContent = latestAssistantMessage?.content ?? "";
  // A follow-up keeps the previous answer, and its help sources, on screen
  // until the new answer has content.
  const displayedMessageRef = useRef<Message | undefined>(undefined);
  if (responseContent) displayedMessageRef.current = latestAssistantMessage;
  const displayedMessage = displayedMessageRef.current;
  const displayedResponse = displayedMessage?.content ?? "";
  const helpEvidence = extractHelpEvidence(displayedMessage?.toolCalls);
  // Keyed by the answer itself, which is what auto-copy confirms; explicit
  // Copy adds the help sources to what it writes.
  const { copied, copyText, confirmCopied } = useCopyFeedback(responseContent, {
    resetMs: MANUAL_COPY_FEEDBACK_MS,
  });

  const [ttsSpeaking, setTtsSpeaking] = useState(() => getTtsSpeakingState().speaking);
  useEffect(() => {
    return subscribeTtsSpeaking((state) => setTtsSpeaking(state.speaking));
  }, []);
  const handleCopy = useCallback(async () => {
    const responseCopyText = helpAnswerPlainText(
      displayedResponse,
      helpEvidence,
      t,
      i18n?.resolvedLanguage
    );
    if (await copyText(responseCopyText.trim())) confirmCopied(responseContent);
  }, [
    copyText,
    confirmCopied,
    displayedResponse,
    helpEvidence,
    t,
    i18n?.resolvedLanguage,
    responseContent,
  ]);

  useEffect(() => {
    onConversationIdChange(persistence.conversationId);
  }, [persistence.conversationId, onConversationIdChange]);

  // Reopening the panel resumes the previous conversation. Sends must wait
  // for the load: a command sent against the still-empty message list would
  // reach the model without the conversation's history, and the load's
  // setMessages would then wipe the just-sent turn from the UI.
  const [historyReady, setHistoryReady] = useState(initialConversationId == null);
  useEffect(() => {
    if (initialConversationId == null) return undefined;

    let active = true;
    void restoreAssistantConversation({
      conversationId: initialConversationId,
      loadConversation: persistence.loadConversation,
      onReady: () => setHistoryReady(true),
      onReset: persistence.handleNewChat,
      onError: (error: unknown) => {
        console.error("Failed to restore Assistant conversation", error);
        toast({ title: t("common.error"), variant: "destructive" });
      },
      isActive: () => active,
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Voice commands arrive as pending commands: send each exactly once.
  const consumedCommandIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !historyReady ||
      submissionInFlight ||
      !pendingCommand ||
      consumedCommandIdRef.current === pendingCommand.id
    ) {
      return;
    }
    consumedCommandIdRef.current = pendingCommand.id;
    const commandId = pendingCommand.id;
    const attachSelection =
      !commandSettings.enabled || commandReferencesSelection(pendingCommand.text);
    const commandForSend = attachSelection
      ? pendingCommand
      : { ...pendingCommand, selectedContext: undefined };
    const { options: sendOptions, wasDelivered } = buildAssistantCommandSendOptions(
      commandForSend,
      {
        onResponseContent,
        deliver: deliverAssistantResponse,
        confirmCopied: (content) => confirmCopied(content, AUTO_COPY_FEEDBACK_MS),
      }
    );
    if (pendingCommand.selectedContext) {
      setSelectedContext(null);
      onSelectionContextChange(null);
    }
    void (async () => {
      setSubmissionInFlight(true);
      try {
        if (await tryCommandMode(pendingCommand.text)) {
          onCommandConsumed(commandId);
          onCommandSettled(commandId, { showPanel: false });
          return;
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error && error.message
            ? error.message
            : error == null
              ? t("common.unknownError")
              : String(error);
        onCommandDiscarded(commandId);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `${t("agentMode.chat.errorPrefix")}: ${errorMessage}`,
            isStreaming: false,
          },
        ]);
        onCommandSettled(commandId, { showPanel: false });
        return;
      } finally {
        setSubmissionInFlight(false);
      }
      await sendMessage(pendingCommand.text, sendOptions)
      .then((sent) => {
        if (sent) {
          touchAssistantChatActivity();
          onCommandConsumed(commandId);
          return;
        }
        // Another submission held the lock; let the effect retry once
        // submissionInFlight flips back to false.
        consumedCommandIdRef.current = null;
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof Error && error.message
            ? error.message
            : error == null
              ? t("common.unknownError")
              : String(error);
        onCommandDiscarded(commandId);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `${t("agentMode.chat.errorPrefix")}: ${errorMessage}`,
            isStreaming: false,
          },
        ]);
      })
      .finally(() => onCommandSettled(commandId, { showPanel: !wasDelivered() }));
    })();
  }, [
    historyReady,
    submissionInFlight,
    pendingCommand,
    onCommandConsumed,
    onCommandDiscarded,
    onCommandSettled,
    onSelectionContextChange,
    onResponseContent,
    confirmCopied,
    sendMessage,
    setMessages,
    t,
    tryCommandMode,
    commandSettings.enabled,
  ]);

  const approvalEntries = useConnectorApprovalStore((state) => state.entries);
  const panelApprovals = latestAssistantMessage
    ? (latestAssistantMessage.toolCalls ?? [])
        .map((toolCall) => approvalEntries[approvalKey(latestAssistantMessage.id, toolCall.id)])
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  const approvalAwaitingUser = panelApprovals.some(
    (entry) => entry.state === "pending" || entry.state === "committing"
  );
  const isToolExecuting = Boolean(streaming.activeToolName) && !approvalAwaitingUser;
  const isBusy = resolveAssistantPanelBusy({
    agentState: streaming.agentState,
    activeToolName: streaming.activeToolName,
    submissionInFlight,
  });
  const showCommandProgress = Boolean(commandProgress) || commandInFlight;
  const commandProgressLabel = useMemo(() => {
    if (commandProgress?.text) return commandProgress.text;
    if (commandProgress?.phase === "writing") {
      return t("assistant.panel.writing", { defaultValue: "Writing…" });
    }
    if (
      commandProgress?.phase === "step" &&
      commandProgress.current != null &&
      commandProgress.total != null
    ) {
      return t("assistant.panel.commandStep", {
        defaultValue: "Working… step {{current}}/{{total}}",
        current: commandProgress.current,
        total: commandProgress.total,
      });
    }
    if (commandProgress?.phase || commandInFlight) {
      return t("assistant.panel.runningCommand", { defaultValue: "Working…" });
    }
    return "";
  }, [commandInFlight, commandProgress, t]);
  const showContentFlourish = thinking || isToolExecuting || showCommandProgress;
  const [toolVerbIndex, setToolVerbIndex] = useState(0);
  const footerPresentation = resolveAssistantFooterPresentation(footerPhase);

  useEffect(() => {
    setToolVerbIndex(0);
    if (!isToolExecuting) return;

    const timer = window.setInterval(() => {
      setToolVerbIndex((current) => (current + 1) % AGENT_TOOL_ACTIVITY_VERB_KEYS.length);
    }, AGENT_TOOL_ACTIVITY_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [isToolExecuting, streaming.activeToolName]);

  useEffect(() => {
    onBusyChange(isBusy);
    return () => onBusyChange(false);
  }, [isBusy, onBusyChange]);

  // Keep the previous response ineligible throughout a follow-up request. Audio
  // processing can return voiceState to idle one render before the chat stream
  // reports busy; without this latch, the old response briefly restores the
  // Close/Copy actions and reverses the footer animation.
  const isResponseReady = resolveAssistantResponseReady({
    responseContent,
    isBusy,
    isStreaming: Boolean(latestAssistantMessage?.isStreaming),
    voiceState,
    requestPending: thinking || pendingCommand != null,
  });
  const responseSelectionRootRef = useRef<HTMLDivElement | null>(null);
  const [selectedContext, setSelectedContext] = useState<AgentSelectionContext | null>(null);

  const clearSelectedContext = useCallback(() => {
    setSelectedContext(null);
    onSelectionContextChange(null);
    window.getSelection()?.removeAllRanges();
  }, [onSelectionContextChange]);

  const handleNewConversation = useCallback(() => {
    if (isBusy || submissionInFlight) return;
    persistence.handleNewChat();
    onConversationIdChange(null);
    clearSelectedContext();
    displayedMessageRef.current = undefined;
    onConversationReset();
  }, [
    clearSelectedContext,
    isBusy,
    onConversationIdChange,
    onConversationReset,
    persistence,
    submissionInFlight,
  ]);

  const handleTextSubmit = useCallback(
    (text: string): void => {
      if (!historyReady) return;
      const context =
        !commandSettings.enabled || commandReferencesSelection(text) ? selectedContext : null;
      if (selectedContext) clearSelectedContext();
      void (async () => {
        setSubmissionInFlight(true);
        try {
          if (await tryCommandMode(text)) {
            touchAssistantChatActivity();
            return;
          }
        } finally {
          setSubmissionInFlight(false);
        }
        const sent = await sendMessage(text, context ? { selectedContext: context } : undefined);
        if (sent) touchAssistantChatActivity();
      })();
    },
    [clearSelectedContext, commandSettings.enabled, historyReady, selectedContext, sendMessage, tryCommandMode]
  );

  const showEmptyState =
    historyReady &&
    messages.length === 0 &&
    streaming.agentState === "idle" &&
    !submissionInFlight &&
    !thinking &&
    pendingCommand === null;

  useEffect(() => {
    if (!open && selectedContext) clearSelectedContext();
  }, [clearSelectedContext, open, selectedContext]);

  useEffect(() => {
    if (!open || !isResponseReady || !latestAssistantMessage) return undefined;

    const captureSelection = () => {
      const selectedText = getSelectionInside(responseSelectionRootRef.current);
      if (!selectedText) return;

      const context = normalizeAgentSelectionContext({
        text: selectedText,
        sourceMessageId: latestAssistantMessage.id,
      });
      if (!context) return;

      setSelectedContext(context);
      onSelectionContextChange(context);
    };

    document.addEventListener("selectionchange", captureSelection);
    return () => document.removeEventListener("selectionchange", captureSelection);
  }, [isResponseReady, latestAssistantMessage, onSelectionContextChange, open]);

  useEffect(
    () => () => {
      onSelectionContextChange(null);
    },
    [onSelectionContextChange]
  );

  useEffect(() => {
    onResponseReadyChange(isResponseReady);
  }, [isResponseReady, onResponseReadyChange]);

  const handleCancelActive = useCallback(() => {
    if (submissionInFlight) {
      cancelCommandMode();
    }
    streaming.cancelStream();
  }, [cancelCommandMode, streaming, submissionInFlight]);

  // Esc cancels a running response or closes the panel. The screenshot's
  // compact `C` hint is also a keyboard shortcut once a response is final.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (voiceState === "listening") return;
        if (isBusy) {
          handleCancelActive();
          // A hidden panel means the compact Beam circle owns the thinking
          // state; cancelling it must also dismiss that otherwise-idle shell.
          if (!open) onClose();
        } else onClose();
        return;
      }

      if (isResponseReady) {
        const selectedText = getSelectionForCopyShortcut(e, responseSelectionRootRef.current);
        if (selectedText) {
          e.preventDefault();
          void copyText(selectedText);
          return;
        }
      }
      const isEditable = isEditableTarget(e.target);
      if (
        isResponseReady &&
        footerPhase === "actions" &&
        e.key.toLowerCase() === "c" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditable
      ) {
        e.preventDefault();
        void handleCopy();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    voiceState,
    isBusy,
    handleCancelActive,
    open,
    onClose,
    isResponseReady,
    footerPhase,
    handleCopy,
    copyText,
  ]);

  return (
    <>
      <header
        className="flex h-16 shrink-0 cursor-grab items-center gap-3 px-5 active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        <BrandMarkIcon size={20} className="shrink-0 text-muted-foreground" />
        {messages.length > 0 && (
          <button
            type="button"
            disabled={isBusy || submissionInFlight}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            aria-label={t("assistant.panel.newConversation")}
            title={t("assistant.panel.newConversation")}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              handleNewConversation();
            }}
          >
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        )}

        <div className="flex min-w-0 flex-1 items-center justify-end text-end text-xs text-muted-foreground/70">
          {selectedContext ? (
            <div className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/55 bg-foreground/[0.06] py-1 ps-2.5 pe-1.5 text-foreground/75">
              <span className="truncate">{t("assistant.panel.selectedContext")}</span>
              <button
                type="button"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label={t("assistant.panel.removeSelectedContext")}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  clearSelectedContext();
                }}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ) : (
            <>
              <span className="truncate">{t("assistant.panel.selectionHint")}</span>
              {readableVoiceHotkey && (
                <kbd
                  dir="ltr"
                  className="ms-2 inline-flex rounded-md border border-border/40 bg-foreground/5 px-2 py-1 font-mono text-[11px] tracking-normal text-foreground/65 shadow-sm"
                >
                  {readableVoiceHotkey}
                </kbd>
              )}
            </>
          )}
        </div>
      </header>

      <div className="relative mx-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/40 bg-surface-1 shadow-inner">
        <main
          data-panel-scroll-region
          className="agent-chat-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4"
          aria-busy={!historyReady || thinking || isBusy}
        >
          <div
            data-panel-size-source
            className={`assistant-response-content min-h-full ${
              showContentFlourish ? "assistant-response-content-updating" : ""
            }`}
          >
            {displayedResponse ? (
              <>
                <div
                  ref={responseSelectionRootRef}
                  style={{ animation: "agent-message-in 160ms ease-out both" }}
                >
                  <StableAssistantMarkdown
                    content={displayedResponse}
                    className="text-[15px] leading-relaxed text-foreground selection:bg-agent-brand/35 selection:text-foreground [&_p]:text-[15px] [&_li]:text-[15px]"
                  />
                  {latestAssistantMessage?.isStreaming && (
                    <span
                      aria-hidden="true"
                      className="ms-0.5 inline-block h-4 w-0.5 align-middle bg-foreground/70"
                      style={{ animation: "agent-cursor-blink 1s ease-in-out infinite" }}
                    />
                  )}
                </div>
                {helpEvidence && <HelpEvidence evidence={helpEvidence} />}
                {/* Outside responseSelectionRootRef: a drag-select + copy over the
                    response must never pick up these affordances. */}
                {latestAssistantMessage?.error?.settingsTarget && (
                  <button
                    type="button"
                    onClick={() =>
                      openProviderSettings(latestAssistantMessage.error!.settingsTarget!)
                    }
                    className="mt-2 text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm"
                  >
                    {t("providerErrors.openSettings")}
                  </button>
                )}
                {latestAssistantMessage?.error?.technicalDetails && (
                  <TechnicalErrorDetails details={latestAssistantMessage.error.technicalDetails} />
                )}
              </>
            ) : null}
            {panelApprovals.map((entry) => (
              <ApprovalCard key={entry.key} entry={entry} />
            ))}
            {thinking && (
              <div role="status">
                <span className="sr-only">{t("agentMode.input.thinking")}</span>
              </div>
            )}
            {showEmptyState && (
              <AssistantEmptyState
                disabled={isBusy || submissionInFlight}
                commandModeEnabled={commandModeEnabled}
                onSelectSuggestion={handleTextSubmit}
              />
            )}
          </div>
        </main>

        <ChatInput
          agentState={historyReady && !submissionInFlight ? streaming.agentState : "thinking"}
          partialTranscript=""
          onTextSubmit={handleTextSubmit}
          onCancel={historyReady ? handleCancelActive : undefined}
          autoFocus={historyReady && open && messages.length === 0}
          className="px-3 pb-3"
        />

        {showContentFlourish && (
          <div
            className="assistant-content-area-shimmer pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl"
            aria-hidden="true"
          />
        )}
        {showCommandProgress && (
          <div
            className="pointer-events-auto absolute inset-x-0 bottom-[4.5rem] z-30 flex justify-center px-6"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-command-progress-phase={commandProgress?.phase ?? "working"}
          >
            <div className="inline-flex max-w-full items-center gap-2.5 rounded-xl border border-border/60 bg-surface-raised/80 px-4 py-2.5 shadow-[var(--shadow-card)] backdrop-blur-md">
              <span
                className="assistant-tool-invocation-pulse relative flex size-2 shrink-0 rounded-full bg-agent-brand"
                aria-hidden="true"
              />
              <span className="truncate text-sm font-medium text-foreground">
                {commandProgressLabel}
              </span>
              <button
                type="button"
                className="ms-1 shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-label={t("assistant.panel.cancelWriting", { defaultValue: t("common.cancel") })}
                onClick={cancelCommandMode}
              >
                {t("assistant.panel.cancelWriting", { defaultValue: t("common.cancel") })}
              </button>
            </div>
          </div>
        )}
        {isToolExecuting && (
          <div
            className="assistant-tool-invocation pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-tool-invocation={streaming.activeToolName}
          >
            <span className="sr-only">{streaming.toolStatus}</span>
            <div
              className="assistant-tool-invocation-status inline-flex max-w-full items-center gap-2.5 rounded-xl border border-border/60 bg-surface-raised/60 px-4 py-2.5 shadow-[var(--shadow-card)] backdrop-blur-md"
              aria-hidden="true"
            >
              <span className="assistant-tool-invocation-pulse relative flex size-2 shrink-0 rounded-full bg-agent-brand" />
              <span
                key={`${streaming.activeToolName}-${toolVerbIndex}`}
                className="assistant-tool-invocation-verb w-16 text-end text-sm text-muted-foreground"
              >
                {t(AGENT_TOOL_ACTIVITY_VERB_KEYS[toolVerbIndex])}
              </span>
              <span className="h-4 w-px shrink-0 bg-border/70" />
              <span className="truncate text-sm font-medium text-foreground">
                {t(`agentMode.tools.${streaming.activeToolName}Name`, {
                  defaultValue: t(AGENT_TOOL_NAME_FALLBACK_KEY),
                })}
              </span>
            </div>
          </div>
        )}
      </div>

      <footer
        className={`flex h-16 shrink-0 items-center px-4 ${
          horizontalDirection === "left" ? "justify-start" : "justify-end"
        }`}
        data-assistant-footer-direction={horizontalDirection}
      >
        {footerPresentation.actionsMounted && (
          <div
            className={`assistant-response-actions flex items-center gap-2 ${
              horizontalDirection === "left" ? "flex-row-reverse" : ""
            }`}
            data-assistant-footer-phase={footerPhase}
            data-horizontal-direction={horizontalDirection}
            aria-hidden={footerPhase !== "actions"}
            style={
              {
                "--assistant-actions-retreat-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.actionsRetreatMs}ms`,
                "--assistant-actions-entrance-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.actionsEntranceMs}ms`,
              } as CSSProperties
            }
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="px-4"
              onClick={onClose}
              tabIndex={footerPhase === "actions" ? 0 : -1}
            >
              <X aria-hidden="true" />
              {t("common.close")}
            </Button>
            {responseContent && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="px-3"
                onClick={() => {
                  if (ttsSpeaking) {
                    stopAssistantTts();
                  } else {
                    void speakAssistantText(helpAnswerPlainText(responseContent, helpEvidence, t, i18n?.resolvedLanguage));
                  }
                }}
                aria-label={
                  ttsSpeaking
                    ? t("assistant.panel.stopSpeaking", { defaultValue: "Stop speaking" })
                    : t("assistant.panel.speak", { defaultValue: "Read aloud" })
                }
                tabIndex={footerPhase === "actions" ? 0 : -1}
              >
                {ttsSpeaking ? (
                  <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <rect x="3" y="3" width="10" height="10" rx="1.5" />
                  </svg>
                ) : (
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )}
                {ttsSpeaking
                  ? t("assistant.panel.stopSpeaking", { defaultValue: "Stop speaking" })
                  : t("assistant.panel.speak", { defaultValue: "Read aloud" })}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              className="bg-surface-raised bg-none px-4 font-medium text-foreground shadow-sm hover:bg-surface-3 dark:bg-white dark:text-neutral-950 dark:hover:bg-white/90"
              onClick={() => void handleCopy()}
              aria-live="polite"
              tabIndex={footerPhase === "actions" ? 0 : -1}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? t("common.copied") : t("assistant.panel.copyToClipboard")}
              {!copied && (
                <kbd
                  dir="ltr"
                  className="ms-1 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-medium dark:bg-black/10"
                >
                  C
                </kbd>
              )}
            </Button>
          </div>
        )}
      </footer>
    </>
  );
}

import React, { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Download, RefreshCw, Loader2 } from "./icons";
import { RequiredModelsBanner } from "./RequiredModelsBanner";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/useToast";
import { useUpdater } from "../hooks/useUpdater";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import {
  useTranscriptions,
  useShowDiscarded,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
  updateTranscription as updateInStore,
  clearTranscriptions as clearStore,
} from "../stores/transcriptionStore";
import { getSettings } from "../stores/settingsStore";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import { getCachedPlatform } from "../utils/platform";
import { isAccessibilitySkipped } from "../utils/permissions";
import HistoryView from "./HistoryView";
import { providerErrorToastProps } from "../utils/describeProviderError";

const platform = getCachedPlatform();

const SIDEBAR_WIDTH_PX = 192;

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const ChatView = React.lazy(() => import("./chat/ChatView"));

interface ControlPanelProps {
  /** Open the settings modal at this section on mount (e.g. after onboarding). */
  initialSettingsSection?: string;
}

export default function ControlPanel({ initialSettingsSection }: ControlPanelProps = {}) {
  const { t } = useTranslation();
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(!!initialSettingsSection);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(
    initialSettingsSection
  );
  // Counts named show-settings requests, so asking again for the section the
  // modal was opened at still lands there after the user moved elsewhere in it.
  const [settingsRequest, setSettingsRequest] = useState(0);
  const showDiscarded = useShowDiscarded();
  const [activeView, setActiveView] = useState<ControlPanelView>("home");
  const navItems = useControlPanelNavItems();
  const {
    collapsed: sidebarCollapsed,
    peek: sidebarPeek,
    toggle: toggleSidebar,
    showPeek: showSidebarPeek,
    hidePeek: hideSidebarPeek,
    leaveToggle: leaveSidebarToggle,
  } = useCollapsibleSidebar();
  const updateReadyToastShown = useRef(false);
  const { hotkey } = useHotkey();
  const { toast } = useToast();

  const {
    status: updateStatus,
    downloadProgress,
    isDownloading,
    isInstalling,
    downloadUpdate,
    installUpdate,
  } = useUpdater();

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const loadTranscriptions = useCallback(
    async (includeDiscarded?: boolean) => {
      try {
        setIsLoading(true);
        await initializeTranscriptions(undefined, includeDiscarded);
      } catch {
        showAlertDialog({
          title: t("controlPanel.history.couldNotLoadTitle"),
          description: t("controlPanel.history.couldNotLoadDescription"),
        });
      } finally {
        setIsLoading(false);
      }
    },
    [showAlertDialog, t]
  );

  useEffect(() => {
    loadTranscriptions();
  }, [loadTranscriptions]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (updateStatus.updateDownloaded && !isDownloading) {
      if (!updateReadyToastShown.current) {
        updateReadyToastShown.current = true;
        toast({
          title: t("controlPanel.update.readyTitle"),
          description: t("controlPanel.update.readyDescription"),
          variant: "success",
        });
      }
    } else {
      updateReadyToastShown.current = false;
    }
  }, [updateStatus.updateDownloaded, isDownloading, toast, t]);

  useEffect(() => {
    // A named section waits in main (it can outrace this listener on a cold
    // start); a bare request (app-menu Cmd+,) keeps an open modal where it is.
    const drain = async (showAnyway: boolean) => {
      const section = await window.electronAPI?.getPendingSettingsSection?.();
      if (section) {
        setSettingsSection(section);
        setSettingsRequest((count) => count + 1);
      }
      if (section || showAnyway) setShowSettings(true);
    };
    drain(false);
    const cleanup = window.electronAPI?.onShowSettings?.(() => drain(true));
    return () => cleanup?.();
  }, []);

  // When accessibility is missing on macOS, open the settings page
  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(async () => {
      if (isAccessibilitySkipped()) return;
      setShowSettings(true);
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [toast, t]);

  // An explicit Copy click on a history row is the only clipboard write on Home.
  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
        dontAskAgainKey: "historyItem",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const clearAllTranscriptions = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.clearAllTitle"),
      description: t("controlPanel.history.clearAllDescriptionDevice"),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          if (result.success) {
            clearStore();
            toast({
              title: t("controlPanel.history.clearAllSuccess"),
              variant: "success",
              duration: 2000,
            });
          } else {
            showAlertDialog({
              title: t("controlPanel.history.clearAllErrorTitle"),
              description: t("controlPanel.history.clearAllErrorDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("controlPanel.history.clearAllErrorTitle"),
            description: t("controlPanel.history.clearAllErrorDescription"),
          });
        }
      },
      variant: "destructive",
    });
  }, [showConfirmDialog, showAlertDialog, toast, t]);

  const showAudioInFolder = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.showAudioInFolder(id);
        if (!result?.success) {
          toast({ title: t("controlPanel.history.audioNotFound"), variant: "destructive" });
        }
      } catch {
        toast({ title: t("controlPanel.history.audioNotFound"), variant: "destructive" });
      }
    },
    [toast, t]
  );

  const retryTranscription = useCallback(
    async (id: number, options?: { isRecover?: boolean }) => {
      try {
        const s = getSettings();
        const result = await window.electronAPI.retryTranscription(id, {
          managed: null,
          useLocalWhisper: s.useLocalWhisper,
          localTranscriptionProvider: s.localTranscriptionProvider,
          cloudTranscriptionMode: s.cloudTranscriptionMode,
          cloudTranscriptionProvider: s.cloudTranscriptionProvider,
          cloudTranscriptionModel: s.cloudTranscriptionModel,
          cloudTranscriptionBaseUrl: s.cloudTranscriptionBaseUrl,
          cortiEnvironment: s.cortiEnvironment,
          cortiTenant: s.cortiTenant,
          parakeetModel: s.parakeetModel,
          cohereModel: s.cohereModel,
          whisperModel: s.whisperModel,
          preferredLanguage: s.preferredLanguage,
          transcriptionMode: s.transcriptionMode,
          remoteTranscriptionType: s.remoteTranscriptionType,
          remoteTranscriptionUrl: s.remoteTranscriptionUrl,
          remoteTranscriptionModel: s.remoteTranscriptionModel,
        });
        if (result.success && result.transcription) {
          updateInStore(result.transcription);
          toast({
            title: t(
              options?.isRecover
                ? "controlPanel.history.discarded.recovered"
                : "controlPanel.history.retrySuccess"
            ),
            ...(result.warning
              ? { description: t("hooks.audioRecording.partialTranscription.description") }
              : {}),
          });
        } else {
          toast({
            title: t("controlPanel.history.retryError"),
            ...providerErrorToastProps({ ...result, message: result.error }, t),
            variant: "destructive",
          });
        }
      } catch {
        toast({ title: t("controlPanel.history.retryError"), variant: "destructive" });
      }
    },
    [toast, t]
  );

  const toggleShowDiscarded = useCallback(() => {
    loadTranscriptions(!showDiscarded);
  }, [loadTranscriptions, showDiscarded]);

  const handleUpdateClick = async () => {
    if (updateStatus.updateDownloaded) {
      showConfirmDialog({
        title: t("controlPanel.update.installTitle"),
        description: t("controlPanel.update.installDescription"),
        onConfirm: async () => {
          try {
            await installUpdate();
          } catch {
            toast({
              title: t("controlPanel.update.couldNotInstallTitle"),
              description: t("controlPanel.update.couldNotInstallDescription"),
              variant: "destructive",
            });
          }
        },
      });
    } else if (updateStatus.updateAvailable && !isDownloading) {
      try {
        await downloadUpdate();
      } catch {
        toast({
          title: t("controlPanel.update.couldNotDownloadTitle"),
          description: t("controlPanel.update.couldNotDownloadDescription"),
          variant: "destructive",
        });
      }
    }
  };

  const getUpdateButtonContent = () => {
    if (isInstalling) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{t("controlPanel.update.installing")}</span>
        </>
      );
    }
    if (isDownloading) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{Math.round(downloadProgress)}%</span>
        </>
      );
    }
    if (updateStatus.updateDownloaded) {
      return (
        <>
          <RefreshCw size={14} />
          <span>{t("controlPanel.update.installButton")}</span>
        </>
      );
    }
    if (updateStatus.updateAvailable) {
      return (
        <>
          <Download size={14} />
          <span>{t("controlPanel.update.availableButton")}</span>
        </>
      );
    }
    return null;
  };

  return (
    <div className="h-screen bg-surface-window flex flex-col">
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        dontAskAgainKey={confirmDialog.dontAskAgainKey}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            // SettingsModal reads initialSection only on open, so a named request remounts it.
            key={`${settingsSection ?? "default"}-${settingsRequest}`}
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        <div
          className="shrink-0 transition-[width] duration-300 ease-out"
          style={{ width: sidebarCollapsed ? 0 : SIDEBAR_WIDTH_PX }}
        />
        <div
          className={`absolute inset-y-0 start-0 z-30 transition-transform duration-300 ease-out ${
            !sidebarCollapsed || sidebarPeek
              ? "translate-x-0"
              : "ltr:-translate-x-full rtl:translate-x-full"
          }${
            sidebarCollapsed && sidebarPeek
              ? " shadow-[10px_0_40px_-18px_rgba(0,0,0,0.2)] rtl:shadow-[-10px_0_40px_-18px_rgba(0,0,0,0.2)]"
              : ""
          }`}
          onMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
          onMouseLeave={sidebarCollapsed ? hideSidebarPeek : undefined}
        >
          <ControlPanelSidebar
            activeView={activeView}
            onViewChange={setActiveView}
            onOpenSettings={() => {
              setSettingsSection(undefined);
              setShowSettings(true);
            }}
            updateAction={
              !updateStatus.isDevelopment &&
              (updateStatus.updateAvailable ||
                updateStatus.updateDownloaded ||
                isDownloading ||
                isInstalling) ? (
                <Button
                  variant={updateStatus.updateDownloaded ? "default" : "outline"}
                  size="sm"
                  onClick={handleUpdateClick}
                  disabled={isInstalling || isDownloading}
                  className="gap-1.5 text-xs w-full h-7"
                >
                  {getUpdateButtonContent()}
                </Button>
              ) : undefined
            }
          />
        </div>
        <main className="flex-1 flex flex-col overflow-hidden p-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <ControlPanelTopBar
              title={navItems.find((item) => item.id === activeView)?.label ?? ""}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onToggleMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
              onToggleMouseLeave={sidebarCollapsed ? leaveSidebarToggle : undefined}
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              <RequiredModelsBanner />
              {activeView === "home" && (
                <HistoryView
                  history={history}
                  isLoading={isLoading}
                  hotkey={hotkey}
                  copyToClipboard={copyToClipboard}
                  deleteTranscription={deleteTranscription}
                  clearAllTranscriptions={clearAllTranscriptions}
                  onShowAudioInFolder={showAudioInFolder}
                  onRetryTranscription={retryTranscription}
                  showDiscarded={showDiscarded}
                  onToggleDiscarded={toggleShowDiscarded}
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                />
              )}
              {activeView === "chat" && (
                <Suspense fallback={null}>
                  <ChatView />
                </Suspense>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
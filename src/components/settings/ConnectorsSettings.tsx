import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Blocks,
  RefreshCw,
  CircleX,
  Trash2,
  Plus,
  Play,
  KeyRound,
  Download,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Shield,
  ShieldCheck,
  Sparkles,
  Loader2,
  X,
} from "../icons";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import {
  McpServerInfo,
  McpToolInfo,
  McpGalleryServer,
  McpDiscoveredServer,
  McpSavedPermission,
} from "../../types/overlayMcp";

interface FeedbackBanner {
  type: "info" | "success" | "error";
  message: string;
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export default function ConnectorsSettings() {
  const { t } = useTranslation();
  const api = window.electronAPI?.overlayMcp;

  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpToolInfo[]>>({});
  const [testResults, setTestResults] = useState<Record<string, FeedbackBanner>>({});
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<McpSavedPermission[]>([]);
  const [permissionFeedback, setPermissionFeedback] = useState<FeedbackBanner | null>(null);

  // Add Server Form State
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<"stdio" | "remote">("stdio");
  const [addCommand, setAddCommand] = useState("");
  const [addArgs, setAddArgs] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addingServer, setAddingServer] = useState(false);
  const [addFeedback, setAddFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Gallery & Import State
  const [gallery, setGallery] = useState<McpGalleryServer[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryFeedback, setGalleryFeedback] = useState<FeedbackBanner | null>(null);
  const [showGallery, setShowGallery] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<McpDiscoveredServer[]>([]);
  const [selectedImports, setSelectedImports] = useState<Record<string, boolean>>({});
  const [envKeyChoices, setEnvKeyChoices] = useState<Record<string, Record<string, boolean>>>({});
  const [importEnvValues, setImportEnvValues] = useState(false);
  const [importFeedback, setImportFeedback] = useState<FeedbackBanner | null>(null);

  // Raw JSON Editor State
  const [rawText, setRawText] = useState("");
  const [editorErrors, setEditorErrors] = useState<string[]>([]);
  const [editorFeedback, setEditorFeedback] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const galleryCloseBtnRef = useRef<HTMLButtonElement>(null);
  const importCloseBtnRef = useRef<HTMLButtonElement>(null);
  const importCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadData = useCallback(async () => {
    if (!api) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const list = await api.list();
      setServers(list || []);
      const cfg = await api.configGet();
      setRawText(cfg.text || "");
      if (typeof api.permissionsList === "function") {
        const perms = await api.permissionsList();
        setPermissions(perms || []);
      }
    } catch (error) {
      setLoadError(formatErrorMessage(error, t("common.unknownError")));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  const handleRevokePermission = async (key: string) => {
    if (!api || typeof api.permissionsRevoke !== "function") return;
    setPermissionFeedback(null);
    try {
      const res = await api.permissionsRevoke(key);
      if (res && res.ok === false) {
        setPermissionFeedback({
          type: "error",
          message: t("mcp.revokeFailed", { defaultValue: "Couldn't revoke permission." }),
        });
        return;
      }
      setPermissionFeedback({
        type: "success",
        message: t("mcp.permissionRevoked", { defaultValue: "Permission revoked." }),
      });
      await loadData();
    } catch (error) {
      setPermissionFeedback({
        type: "error",
        message: formatErrorMessage(
          error,
          t("mcp.revokeFailed", { defaultValue: "Couldn't revoke permission." })
        ),
      });
    }
  };

  useEffect(() => {
    void loadData();
    if (!api) return;
    const unsub = api.onStatus(() => {
      void loadData();
    });
    return () => {
      unsub?.();
    };
  }, [api, loadData]);

  useEffect(() => {
    return () => {
      if (importCloseTimerRef.current) {
        clearTimeout(importCloseTimerRef.current);
      }
    };
  }, []);

  const restoreModalTriggerFocus = useCallback(() => {
    const trigger = modalTriggerRef.current;
    modalTriggerRef.current = null;
    if (!trigger) return;
    requestAnimationFrame(() => {
      trigger.focus();
    });
  }, []);

  const closeGallery = useCallback(() => {
    setShowGallery(false);
    restoreModalTriggerFocus();
  }, [restoreModalTriggerFocus]);

  const closeImport = useCallback(() => {
    if (importCloseTimerRef.current) {
      clearTimeout(importCloseTimerRef.current);
      importCloseTimerRef.current = null;
    }
    setShowImport(false);
    restoreModalTriggerFocus();
  }, [restoreModalTriggerFocus]);

  useEffect(() => {
    if (!showGallery && !showImport) return;
    const frame = requestAnimationFrame(() => {
      if (showGallery) galleryCloseBtnRef.current?.focus();
      else if (showImport) importCloseBtnRef.current?.focus();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (showGallery) closeGallery();
      else if (showImport) closeImport();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showGallery, showImport, closeGallery, closeImport]);

  const clearServerResult = (name: string) => {
    setTestResults((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleConnect = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      const res = await api.connect(name);
      if (res && res.ok === false) {
        setTestResults((prev) => ({
          ...prev,
          [name]: { type: "error", message: `Error: ${res.error || t("common.unknownError")}` },
        }));
      } else {
        clearServerResult(name);
      }
      await loadData();
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { type: "error", message: `Error: ${formatErrorMessage(error, t("common.unknownError"))}` },
      }));
    } finally {
      setBusyServer(null);
    }
  };

  const handleDisconnect = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      const res = await api.disconnect(name);
      if (res && res.ok === false) {
        setTestResults((prev) => ({
          ...prev,
          [name]: {
            type: "error",
            message: t("mcp.disconnectFailed", { defaultValue: "Couldn't disconnect server." }),
          },
        }));
      } else {
        clearServerResult(name);
      }
      await loadData();
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { type: "error", message: `Error: ${formatErrorMessage(error, t("common.unknownError"))}` },
      }));
    } finally {
      setBusyServer(null);
    }
  };

  const handleAuth = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      const res = await api.auth(name);
      if (res && !res.ok) {
        setTestResults((prev) => ({
          ...prev,
          [name]: { type: "error", message: `Auth failed: ${res.error || t("common.unknownError")}` },
        }));
      } else {
        clearServerResult(name);
      }
      await loadData();
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [name]: {
          type: "error",
          message: `Auth failed: ${formatErrorMessage(error, t("common.unknownError"))}`,
        },
      }));
    } finally {
      setBusyServer(null);
    }
  };

  const handleTest = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    setTestResults((prev) => ({
      ...prev,
      [name]: {
        type: "info",
        message: t("mcp.testingConnection", { defaultValue: "Testing connection and tools..." }),
      },
    }));
    try {
      const res = await api.test(name);
      if (res.ok) {
        setTestResults((prev) => ({
          ...prev,
          [name]: {
            type: "success",
            message: `Success! Discovered ${res.tools?.length || 0} tools.`,
          },
        }));
        if (res.tools) {
          setToolsByServer((prev) => ({ ...prev, [name]: res.tools! }));
        }
      } else {
        setTestResults((prev) => ({
          ...prev,
          [name]: {
            type: "error",
            message: `Test failed: ${res.error || t("common.unknownError")}`,
          },
        }));
      }
      await loadData();
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [name]: {
          type: "error",
          message: `Test failed: ${formatErrorMessage(error, t("common.unknownError"))}`,
        },
      }));
    } finally {
      setBusyServer(null);
    }
  };

  const handleRemove = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      const res = await api.remove(name);
      if (res && res.ok === false && !res.cancelled) {
        setTestResults((prev) => ({
          ...prev,
          [name]: {
            type: "error",
            message: res.errors?.join(", ") || t("common.unknownError"),
          },
        }));
        return;
      }
      if (!res?.cancelled) {
        clearServerResult(name);
        if (expandedServer === name) setExpandedServer(null);
      }
      await loadData();
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { type: "error", message: `Error: ${formatErrorMessage(error, t("common.unknownError"))}` },
      }));
    } finally {
      setBusyServer(null);
    }
  };

  const toggleTools = async (serverName: string) => {
    if (expandedServer === serverName) {
      setExpandedServer(null);
      return;
    }
    setExpandedServer(serverName);
    if (!api) return;
    try {
      const tools = await api.tools(serverName);
      setToolsByServer((prev) => ({ ...prev, [serverName]: tools || [] }));
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [serverName]: {
          type: "error",
          message: `Error loading tools: ${formatErrorMessage(error, t("common.unknownError"))}`,
        },
      }));
    }
  };

  const handleToggleTool = async (serverName: string, toolName: string, currentEnabled: boolean) => {
    if (!api) return;
    const next = !currentEnabled;
    try {
      const res = await api.setToolEnabled(serverName, toolName, next);
      if (res && res.ok === false) {
        setTestResults((prev) => ({
          ...prev,
          [serverName]: {
            type: "error",
            message: t("mcp.toolToggleFailed", { defaultValue: "Couldn't update tool state." }),
          },
        }));
        return;
      }
      setToolsByServer((prev) => ({
        ...prev,
        [serverName]: (prev[serverName] || []).map((t) =>
          t.name === toolName ? { ...t, enabled: next } : t
        ),
      }));
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [serverName]: {
          type: "error",
          message: `Error: ${formatErrorMessage(error, t("common.unknownError"))}`,
        },
      }));
    }
  };

  const handleAddServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api || addingServer) return;
    const name = addName.trim();
    if (!name) {
      setAddFeedback({ type: "error", message: t("mcp.nameRequired") });
      return;
    }

    let cfg: Record<string, unknown> = {};
    if (addType === "stdio") {
      if (!addCommand.trim()) {
        setAddFeedback({ type: "error", message: t("mcp.commandRequired") });
        return;
      }
      const args = addArgs
        .split(" ")
        .map((a) => a.trim())
        .filter(Boolean);
      cfg = { command: addCommand.trim(), args };
    } else {
      if (!addUrl.trim()) {
        setAddFeedback({ type: "error", message: t("mcp.urlRequired") });
        return;
      }
      cfg = { url: addUrl.trim() };
    }

    setAddingServer(true);
    try {
      const res = await api.add(name, cfg);
      if (res.ok) {
        setAddFeedback({ type: "success", message: t("mcp.serverAdded") });
        setAddName("");
        setAddCommand("");
        setAddArgs("");
        setAddUrl("");
        await loadData();
      } else {
        setAddFeedback({ type: "error", message: res.errors.join(", ") });
      }
    } catch (error) {
      setAddFeedback({ type: "error", message: formatErrorMessage(error, t("common.unknownError")) });
    } finally {
      setAddingServer(false);
    }
  };

  const openGallery = async (event?: React.MouseEvent<HTMLElement>) => {
    if (!api) return;
    modalTriggerRef.current =
      (event?.currentTarget as HTMLElement | undefined) ?? (document.activeElement as HTMLElement | null);
    setGalleryFeedback(null);
    setShowGallery(true);
    setGalleryLoading(true);
    try {
      const list = await api.gallery();
      setGallery(list || []);
    } catch (error) {
      setGallery([]);
      setGalleryFeedback({
        type: "error",
        message: formatErrorMessage(error, t("common.unknownError")),
      });
    } finally {
      setGalleryLoading(false);
    }
  };

  const addFromGallery = async (server: McpGalleryServer) => {
    if (!api) return;
    setGalleryFeedback(null);
    try {
      const res = await api.add(server.id, server.config);
      if (res && !res.ok) {
        setGalleryFeedback({
          type: "error",
          message: res.errors?.join(", ") || t("common.unknownError"),
        });
        return;
      }
      closeGallery();
      await loadData();
    } catch (error) {
      setGalleryFeedback({
        type: "error",
        message: formatErrorMessage(error, t("common.unknownError")),
      });
    }
  };

  const openImport = async (event?: React.MouseEvent<HTMLElement>) => {
    if (!api) return;
    modalTriggerRef.current =
      (event?.currentTarget as HTMLElement | undefined) ?? (document.activeElement as HTMLElement | null);
    setShowImport(true);
    setImportFeedback(null);
    setImportLoading(true);
    try {
      const discovered = await api.importDiscover();
      setDiscoveredServers(discovered || []);
      const initialSelect: Record<string, boolean> = {};
      (discovered || []).forEach((d) => {
        initialSelect[d.id] = true;
      });
      setSelectedImports(initialSelect);
      setEnvKeyChoices({});
    } catch (error) {
      setDiscoveredServers([]);
      setImportFeedback({
        type: "error",
        message: formatErrorMessage(error, t("common.unknownError")),
      });
    } finally {
      setImportLoading(false);
    }
  };

  const executeImport = async () => {
    if (!api || importing) return;
    const selected = discoveredServers.filter((d) => selectedImports[d.id]);
    if (selected.length === 0) {
      setImportFeedback({ type: "error", message: t("mcp.noServersSelected") });
      return;
    }
    setImporting(true);
    try {
      const res = await api.importServers(
        selected.map((s) => s.id),
        envKeyChoices,
        importEnvValues
      );
      if (res.ok) {
        setImportFeedback({ type: "success", message: t("mcp.importSuccess", { count: res.imported }) });
        await loadData();
        importCloseTimerRef.current = setTimeout(() => closeImport(), 1500);
      } else {
        setImportFeedback({ type: "error", message: `Error: ${res.errors.join(", ")}` });
      }
    } catch (error) {
      setImportFeedback({
        type: "error",
        message: `Error: ${formatErrorMessage(error, t("common.unknownError"))}`,
      });
    } finally {
      setImporting(false);
    }
  };

  const handleValidateRaw = async () => {
    if (!api) return;
    try {
      JSON.parse(rawText);
      const res = await api.configSave(rawText);
      if (res.ok) {
        setEditorErrors([]);
        setEditorFeedback(t("mcp.configValid"));
      } else {
        setEditorErrors(res.errors);
        setEditorFeedback(null);
      }
    } catch (e: unknown) {
      setEditorErrors([`Invalid JSON: ${formatErrorMessage(e, t("common.unknownError"))}`]);
      setEditorFeedback(null);
    }
  };

  const handleSaveRaw = async () => {
    if (!api) return;
    try {
      JSON.parse(rawText);
      const res = await api.configSave(rawText);
      if (res.ok) {
        setEditorErrors([]);
        setEditorFeedback(t("mcp.configSaved"));
        await loadData();
      } else {
        setEditorErrors(res.errors);
        setEditorFeedback(null);
      }
    } catch (e: unknown) {
      setEditorErrors([`Invalid JSON: ${formatErrorMessage(e, t("common.unknownError"))}`]);
      setEditorFeedback(null);
    }
  };

  const lineCount = rawText.split("\n").length;
  const lineNumbers = Array.from({ length: Math.max(lineCount, 1) }, (_, i) => i + 1);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <SectionHeader
            title={t("mcp.title")}
            description={t("mcp.description")}
          />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={(e) => void openGallery(e)}>
              <Sparkles className="size-3.5" aria-hidden="true" />
              {t("mcp.galleryButton")}
            </Button>
            <Button variant="outline" size="sm" onClick={(e) => void openImport(e)}>
              <Download className="size-3.5" aria-hidden="true" />
              {t("mcp.importButton")}
            </Button>
          </div>
        </div>

        {/* Server List */}
        <SettingsPanel className="mt-4">
          {loading ? (
            <SettingsPanelRow>
              <p className="flex items-center gap-2 text-xs text-muted-foreground/80" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("common.loading")}
              </p>
            </SettingsPanelRow>
          ) : loadError ? (
            <SettingsPanelRow>
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <div className="flex items-center gap-2">
                  <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                  <span>{loadError}</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLoading(true);
                    void loadData();
                  }}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  {t("common.retry")}
                </Button>
              </div>
            </SettingsPanelRow>
          ) : servers.length === 0 ? (
            <SettingsPanelRow>
              <div className="py-6 text-center">
                <Blocks className="mx-auto size-8 text-muted-foreground/50" aria-hidden="true" />
                <h4 className="mt-2 text-xs font-medium text-foreground">{t("mcp.noServers")}</h4>
                <p className="mt-1 text-xs text-muted-foreground/80">{t("mcp.noServersHint")}</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button size="sm" onClick={(e) => void openGallery(e)}>
                    <Sparkles className="size-3.5" aria-hidden="true" />
                    {t("mcp.exploreGallery")}
                  </Button>
                </div>
              </div>
            </SettingsPanelRow>
          ) : (
            servers.map((server) => {
              const isBusy = busyServer === server.name;
              const tools = toolsByServer[server.name] || [];
              const testMsg = testResults[server.name];
              const isExpanded = expandedServer === server.name;

              return (
                <div key={server.name} className="border-b border-border/50 last:border-b-0">
                  <SettingsPanelRow>
                    <div className="flex flex-col gap-3 py-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => void toggleTools(server.name)}
                            aria-expanded={isExpanded}
                            aria-label={
                              isExpanded
                                ? t("mcp.hideTools", {
                                    defaultValue: "Hide tools for {{name}}",
                                    name: server.name,
                                  })
                                : t("mcp.showTools", {
                                    defaultValue: "Show tools for {{name}}",
                                    name: server.name,
                                  })
                            }
                            className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          >
                            {isExpanded ? (
                              <ChevronDown className="size-4" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="size-4" aria-hidden="true" />
                            )}
                          </button>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-foreground">
                                {server.name}
                              </span>
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                                  server.status === "connected"
                                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                    : server.status === "connecting"
                                    ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                    : server.status === "needsAuth"
                                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                    : server.status === "error"
                                    ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                                    : "bg-surface-2 text-muted-foreground"
                                }`}
                              >
                                {t(`mcp.status.${server.status}`)}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                ({server.type})
                              </span>
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground/80 font-mono">
                              {server.command
                                ? [server.command, ...(server.args || [])].join(" ")
                                : server.url}
                            </p>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5">
                          {server.type === "remote" && server.status === "needsAuth" && (
                            <Button
                              variant="default"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => void handleAuth(server.name)}
                            >
                              <KeyRound className="size-3.5" aria-hidden="true" />
                              {t("mcp.signIn")}
                            </Button>
                          )}
                          {server.status === "connected" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => void handleDisconnect(server.name)}
                            >
                              <CircleX className="size-3.5 text-rose-500" aria-hidden="true" />
                              {t("mcp.disconnect")}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => void handleConnect(server.name)}
                            >
                              <Play className="size-3.5 text-emerald-500" aria-hidden="true" />
                              {t("mcp.connect")}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => void handleTest(server.name)}
                          >
                            <RefreshCw
                              className={`size-3.5 ${isBusy ? "animate-spin" : ""}`}
                              aria-hidden="true"
                            />
                            {t("mcp.test")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isBusy}
                            aria-label={t("mcp.removeServer", {
                              defaultValue: "Remove {{name}}",
                              name: server.name,
                            })}
                            title={t("mcp.removeServer", {
                              defaultValue: "Remove {{name}}",
                              name: server.name,
                            })}
                            onClick={() => void handleRemove(server.name)}
                            className="text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>

                      {testMsg && (
                        <div
                          role={testMsg.type === "error" ? "alert" : "status"}
                          aria-live="polite"
                          className={`rounded px-2.5 py-1 text-xs ${
                            testMsg.type === "success"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : testMsg.type === "error"
                              ? "bg-destructive/10 text-destructive"
                              : "bg-surface-2 text-muted-foreground"
                          }`}
                        >
                          {testMsg.message}
                        </div>
                      )}

                      {/* Expanded Tools List */}
                      {isExpanded && (
                        <div className="mt-2 space-y-2 rounded-md border border-border/40 bg-surface-2/40 p-3">
                          <h5 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                            {t("mcp.toolsTitle", { count: tools.length })}
                          </h5>
                          {tools.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              {t("mcp.noToolsDiscovered")}
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {tools.map((tool) => {
                                const isReadOnly = tool.annotations?.readOnlyHint === true;
                                const isDestructive = tool.annotations?.destructiveHint === true;

                                return (
                                  <div
                                    key={tool.name}
                                    className="flex items-start justify-between gap-3 rounded border border-border/30 bg-surface-1/60 p-2 text-xs"
                                  >
                                    <div className="space-y-0.5">
                                      <div className="flex items-center gap-2">
                                        <span className="font-mono font-medium text-foreground">
                                          {tool.name}
                                        </span>
                                        {isReadOnly ? (
                                          <span className="flex items-center gap-0.5 rounded bg-emerald-500/10 px-1 py-0.2 text-[10px] text-emerald-600 dark:text-emerald-400">
                                            <ShieldCheck className="size-3" aria-hidden="true" />
                                            {t("mcp.readOnly")}
                                          </span>
                                        ) : isDestructive ? (
                                          <span className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-0.2 text-[10px] text-amber-600 dark:text-amber-400">
                                            <Shield className="size-3" aria-hidden="true" />
                                            {t("mcp.destructive")}
                                          </span>
                                        ) : null}
                                      </div>
                                      <p className="text-muted-foreground/90">
                                        {tool.description || t("mcp.noToolDescription")}
                                      </p>
                                    </div>
                                    <Toggle
                                      checked={tool.enabled !== false}
                                      ariaLabel={t("mcp.toggleTool", {
                                        defaultValue: "Toggle {{name}}",
                                        name: tool.name,
                                      })}
                                      onChange={() =>
                                        void handleToggleTool(
                                          server.name,
                                          tool.name,
                                          tool.enabled !== false
                                        )
                                      }
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </SettingsPanelRow>
                </div>
              );
            })
          )}
        </SettingsPanel>
      </div>

      {/* Add Server Form */}
      <div>
        <SectionHeader
          title={t("mcp.addServerTitle")}
          description={t("mcp.addServerDescription")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <form onSubmit={handleAddServer} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="mcp-server-name" className="text-xs font-medium text-foreground">
                    {t("mcp.serverName")}
                  </label>
                  <Input
                    id="mcp-server-name"
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder={t("mcp.serverNamePlaceholder")}
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="mcp-server-type" className="text-xs font-medium text-foreground">
                    {t("mcp.serverType")}
                  </label>
                  <select
                    id="mcp-server-type"
                    value={addType}
                    onChange={(e) => setAddType(e.target.value as "stdio" | "remote")}
                    className="h-8 w-full rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs text-foreground"
                  >
                    <option value="stdio">{t("mcp.typeStdio")}</option>
                    <option value="remote">{t("mcp.typeRemote")}</option>
                  </select>
                </div>
              </div>

              {addType === "stdio" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="mcp-server-command" className="text-xs font-medium text-foreground">
                      {t("mcp.command")}
                    </label>
                    <Input
                      id="mcp-server-command"
                      value={addCommand}
                      onChange={(e) => setAddCommand(e.target.value)}
                      placeholder="npx, node, python"
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="mcp-server-args" className="text-xs font-medium text-foreground">
                      {t("mcp.args")}
                    </label>
                    <Input
                      id="mcp-server-args"
                      value={addArgs}
                      onChange={(e) => setAddArgs(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-filesystem C:\Docs"
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <label htmlFor="mcp-server-url" className="text-xs font-medium text-foreground">
                    {t("mcp.url")}
                  </label>
                  <Input
                    id="mcp-server-url"
                    value={addUrl}
                    onChange={(e) => setAddUrl(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}

              {addFeedback && (
                <div
                  role={addFeedback.type === "error" ? "alert" : "status"}
                  aria-live="polite"
                  className={`flex items-center gap-2 rounded px-3 py-2 text-xs ${
                    addFeedback.type === "success"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {addFeedback.type === "success" ? (
                    <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  <span>{addFeedback.message}</span>
                </div>
              )}

              <Button type="submit" size="sm" disabled={addingServer}>
                {addingServer ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="size-3.5" aria-hidden="true" />
                )}
                {t("mcp.addServerButton")}
              </Button>
            </form>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      {/* Saved Permissions Panel */}
      <div>
        <SectionHeader
          title={t("mcp.permissionsTitle", { defaultValue: "Saved Permissions" })}
          description={t("mcp.permissionsDescription", {
            defaultValue: "Actions and MCP tools previously authorized to 'Always allow'. You can revoke permissions at any time.",
          })}
        />
        <SettingsPanel className="mt-4">
          {permissionFeedback && (
            <SettingsPanelRow>
              <div
                role={permissionFeedback.type === "error" ? "alert" : "status"}
                aria-live="polite"
                className={`flex items-center gap-2 rounded px-3 py-2 text-xs ${
                  permissionFeedback.type === "success"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {permissionFeedback.type === "success" ? (
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                )}
                <span>{permissionFeedback.message}</span>
              </div>
            </SettingsPanelRow>
          )}
          {permissions.length === 0 ? (
            <SettingsPanelRow>
              <p className="py-2 text-xs text-muted-foreground">
                {t("mcp.noPermissions", { defaultValue: "No actions are currently marked as 'Always allow'." })}
              </p>
            </SettingsPanelRow>
          ) : (
            permissions.map((perm) => (
              <SettingsPanelRow key={perm.key}>
                <div className="flex items-center justify-between py-1 w-full">
                  <div>
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="size-4 text-emerald-500" aria-hidden="true" />
                      <span className="text-xs font-semibold text-foreground font-mono">
                        {perm.tool ? `${perm.server} / ${perm.tool}` : perm.action}
                      </span>
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
                        {perm.type}
                      </span>
                    </div>
                    {perm.allowedAt ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Allowed on {new Date(perm.allowedAt).toLocaleDateString()}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRevokePermission(perm.key)}
                    className="text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    {t("mcp.revoke", { defaultValue: "Revoke" })}
                  </Button>
                </div>
              </SettingsPanelRow>
            ))
          )}
        </SettingsPanel>
      </div>

      {/* Raw mcp.json editor */}
      <div>
        <SectionHeader
          title={t("mcp.editorTitle")}
          description={t("mcp.editorDescription")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[11px] text-muted-foreground">%APPDATA%\Overlay\mcp.json</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void handleValidateRaw()}>
                    {t("common.validate")}
                  </Button>
                  <Button size="sm" onClick={() => void handleSaveRaw()}>
                    {t("common.save")}
                  </Button>
                </div>
              </div>

              {editorFeedback && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 rounded bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400"
                >
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                  <span>{editorFeedback}</span>
                </div>
              )}

              {editorErrors.length > 0 && (
                <div role="alert" className="rounded bg-destructive/10 p-3 text-xs text-destructive">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertCircle className="size-4" aria-hidden="true" />
                    <span>{t("mcp.errorsFound", { count: editorErrors.length })}:</span>
                  </div>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    {editorErrors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="relative flex h-60 w-full overflow-hidden rounded-md border border-border/70 bg-surface-1 font-mono text-xs">
                <div
                  ref={gutterRef}
                  className="flex flex-col select-none border-r border-border/40 bg-surface-2/60 px-2 py-2 text-right text-muted-foreground/50"
                  aria-hidden="true"
                >
                  {lineNumbers.map((num) => (
                    <div key={num} className="h-5 leading-5">
                      {num}
                    </div>
                  ))}
                </div>
                <textarea
                  ref={textareaRef}
                  aria-label={t("mcp.editorTitle")}
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  onScroll={() => {
                    if (textareaRef.current && gutterRef.current) {
                      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
                    }
                  }}
                  spellCheck={false}
                  className="h-full flex-1 resize-none bg-transparent p-2 leading-5 text-foreground outline-none focus:ring-0"
                />
              </div>
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      {/* Gallery Modal */}
      {showGallery && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeGallery();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-gallery-modal-title"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 id="mcp-gallery-modal-title" className="text-sm font-semibold text-foreground">
                  {t("mcp.galleryModalTitle")}
                </h3>
                <p className="text-xs text-muted-foreground">{t("mcp.galleryModalDescription")}</p>
              </div>
              <Button
                ref={galleryCloseBtnRef}
                variant="ghost"
                size="sm"
                aria-label={t("common.close")}
                onClick={closeGallery}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {galleryFeedback && (
              <div
                role={galleryFeedback.type === "error" ? "alert" : "status"}
                aria-live="polite"
                className={`mt-3 flex items-center gap-2 rounded px-3 py-2 text-xs ${
                  galleryFeedback.type === "success"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <span>{galleryFeedback.message}</span>
              </div>
            )}
            {galleryLoading ? (
              <p className="flex items-center gap-2 py-8 text-xs text-muted-foreground" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("common.loading")}
              </p>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3">
                {gallery.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col justify-between rounded-lg border border-border/60 bg-surface-1/70 p-3"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold text-foreground">{item.name}</h4>
                        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {item.type}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                      {item.notice && (
                        <p className="mt-1 text-[11px] font-medium text-amber-500">
                          {item.notice}
                        </p>
                      )}
                      {item.type === "stdio" && item.config.command && (
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground/80 break-all">
                          {[item.config.command, ...(item.config.args || [])].join(" ")}
                        </p>
                      )}
                      {item.verifiedOn && (
                        <p className="mt-1.5 text-[10px] text-muted-foreground/70">
                          Verified {item.verifiedOn} ·{" "}
                          <a
                            href={item.verifiedUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            Docs
                          </a>
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 w-full"
                      onClick={() => void addFromGallery(item)}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      {t("mcp.addFromGallery")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeImport();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-import-modal-title"
            className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 id="mcp-import-modal-title" className="text-sm font-semibold text-foreground">
                  {t("mcp.importModalTitle")}
                </h3>
                <p className="text-xs text-muted-foreground">{t("mcp.importModalDescription")}</p>
              </div>
              <Button
                ref={importCloseBtnRef}
                variant="ghost"
                size="sm"
                aria-label={t("common.close")}
                onClick={closeImport}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>

            <div className="mt-4 space-y-3">
              {importLoading ? (
                <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground" role="status">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  {t("common.loading")}
                </p>
              ) : discoveredServers.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {t("mcp.noExternalServersFound")}
                </p>
              ) : (
                discoveredServers.map((s) => {
                  const key = s.id;
                  const isChecked = selectedImports[key] !== false;
                  return (
                    <div
                      key={key}
                      className="flex items-start justify-between rounded border border-border/50 bg-surface-1/70 p-3"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-foreground">{s.serverName}</span>
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {s.source}
                          </span>
                        </div>
                        {s.hasEnvSecrets && (
                          <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-500">
                            <AlertCircle className="size-3" aria-hidden="true" />
                            {t("mcp.containsEnvSecrets", { keys: s.envKeys.join(", ") })}
                          </p>
                        )}
                        {s.envDetails && s.envDetails.length > 0 && (
                          <div className="mt-2 space-y-1 rounded bg-surface-2/60 p-2 text-xs">
                            <p className="text-[11px] font-medium text-muted-foreground">
                              {t("mcp.envVariables", { defaultValue: "Environment variables (select keys to import values)" })}:
                            </p>
                            {s.envDetails.map((envItem) => {
                              const isKeyChecked = envKeyChoices[s.id]?.[envItem.key] === true;
                              return (
                                <label
                                  key={envItem.key}
                                  className="flex items-center justify-between gap-2 py-0.5 text-[11px] cursor-pointer"
                                >
                                  <span className="font-mono text-foreground flex items-center gap-1.5">
                                    {envItem.key}
                                    <span className="text-muted-foreground font-sans">
                                      ({envItem.maskedValue || "empty"})
                                    </span>
                                  </span>
                                  <input
                                    type="checkbox"
                                    checked={isKeyChecked}
                                    onChange={(e) => {
                                      const checked = e.target.checked;
                                      setEnvKeyChoices((prev) => ({
                                        ...prev,
                                        [s.id]: {
                                          ...(prev[s.id] || {}),
                                          [envItem.key]: checked,
                                        },
                                      }));
                                    }}
                                    className="size-3.5 rounded border-border"
                                  />
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <input
                        type="checkbox"
                        aria-label={s.serverName}
                        checked={isChecked}
                        onChange={(e) =>
                          setSelectedImports((prev) => ({ ...prev, [key]: e.target.checked }))
                        }
                        className="size-4 rounded border-border"
                      />
                    </div>
                  );
                })
              )}

              {discoveredServers.some((s) => s.hasEnvSecrets) && (
                <div className="mt-3 flex items-center gap-2 rounded bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
                  <input
                    type="checkbox"
                    id="importEnv"
                    checked={importEnvValues}
                    onChange={(e) => setImportEnvValues(e.target.checked)}
                    className="size-4"
                  />
                  <label htmlFor="importEnv" className="cursor-pointer">
                    {t("mcp.importEnvValuesPrompt")}
                  </label>
                </div>
              )}

              {importFeedback && (
                <p
                  role={importFeedback.type === "error" ? "alert" : "status"}
                  aria-live="polite"
                  className={`mt-2 text-xs font-medium ${
                    importFeedback.type === "error"
                      ? "text-destructive"
                      : "text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {importFeedback.message}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={closeImport}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void executeImport()}
                  disabled={importLoading || importing || discoveredServers.length === 0}
                >
                  {importing && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                  {t("mcp.importConfirm")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

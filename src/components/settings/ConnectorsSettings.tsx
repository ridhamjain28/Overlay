import React, { useState, useEffect, useRef } from "react";
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

export default function ConnectorsSettings() {
  const { t } = useTranslation();
  const api = window.electronAPI?.overlayMcp;

  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpToolInfo[]>>({});
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<McpSavedPermission[]>([]);

  // Add Server Form State
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<"stdio" | "remote">("stdio");
  const [addCommand, setAddCommand] = useState("");
  const [addArgs, setAddArgs] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addFeedback, setAddFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Gallery & Import State
  const [gallery, setGallery] = useState<McpGalleryServer[]>([]);
  const [showGallery, setShowGallery] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<McpDiscoveredServer[]>([]);
  const [selectedImports, setSelectedImports] = useState<Record<string, boolean>>({});
  const [envKeyChoices, setEnvKeyChoices] = useState<Record<string, Record<string, boolean>>>({});
  const [importEnvValues, setImportEnvValues] = useState(false);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);

  // Raw JSON Editor State
  const [rawText, setRawText] = useState("");
  const [editorErrors, setEditorErrors] = useState<string[]>([]);
  const [editorFeedback, setEditorFeedback] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const loadData = async () => {
    if (!api) return;
    try {
      const list = await api.list();
      setServers(list || []);
      const cfg = await api.configGet();
      setRawText(cfg.text || "");
      if (typeof api.permissionsList === "function") {
        const perms = await api.permissionsList();
        setPermissions(perms || []);
      }
    } catch {}
    setLoading(false);
  };

  const handleRevokePermission = async (key: string) => {
    if (!api || typeof api.permissionsRevoke !== "function") return;
    await api.permissionsRevoke(key);
    await loadData();
  };

  useEffect(() => {
    void loadData();
    if (!api) return;
    const unsub = api.onStatus(() => {
      void loadData();
    });
    return () => unsub?.();
  }, []);

  const handleConnect = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      await api.connect(name);
      await loadData();
    } catch (e: any) {
      setTestResults((prev) => ({ ...prev, [name]: `Error: ${e.message}` }));
    } finally {
      setBusyServer(null);
    }
  };

  const handleDisconnect = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      await api.disconnect(name);
      await loadData();
    } finally {
      setBusyServer(null);
    }
  };

  const handleAuth = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      const res = await api.auth(name);
      if (!res.ok) {
        setTestResults((prev) => ({ ...prev, [name]: `Auth failed: ${res.error}` }));
      }
      await loadData();
    } finally {
      setBusyServer(null);
    }
  };

  const handleTest = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    setTestResults((prev) => ({ ...prev, [name]: "Testing connection and tools..." }));
    try {
      const res = await api.test(name);
      if (res.ok) {
        setTestResults((prev) => ({
          ...prev,
          [name]: `Success! Discovered ${res.tools?.length || 0} tools.`,
        }));
        if (res.tools) {
          setToolsByServer((prev) => ({ ...prev, [name]: res.tools! }));
        }
      } else {
        setTestResults((prev) => ({ ...prev, [name]: `Test failed: ${res.error}` }));
      }
      await loadData();
    } catch (e: any) {
      setTestResults((prev) => ({ ...prev, [name]: `Test failed: ${e.message}` }));
    } finally {
      setBusyServer(null);
    }
  };

  const handleRemove = async (name: string) => {
    if (!api) return;
    setBusyServer(name);
    try {
      await api.remove(name);
      await loadData();
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
      setToolsByServer((prev) => ({ ...prev, [serverName]: tools }));
    } catch {}
  };

  const handleToggleTool = async (serverName: string, toolName: string, currentEnabled: boolean) => {
    if (!api) return;
    const next = !currentEnabled;
    await api.setToolEnabled(serverName, toolName, next);
    setToolsByServer((prev) => ({
      ...prev,
      [serverName]: (prev[serverName] || []).map((t) =>
        t.name === toolName ? { ...t, enabled: next } : t
      ),
    }));
  };

  const handleAddServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;
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
  };

  const openGallery = async () => {
    if (!api) return;
    setShowGallery(true);
    const list = await api.gallery();
    setGallery(list || []);
  };

  const addFromGallery = async (server: McpGalleryServer) => {
    if (!api) return;
    await api.add(server.id, server.config);
    setShowGallery(false);
    await loadData();
  };

  const openImport = async () => {
    if (!api) return;
    setShowImport(true);
    setImportFeedback(null);
    const discovered = await api.importDiscover();
    setDiscoveredServers(discovered || []);
    const initialSelect: Record<string, boolean> = {};
    (discovered || []).forEach((d) => {
      initialSelect[d.id] = true;
    });
    setSelectedImports(initialSelect);
    setEnvKeyChoices({});
  };

  const executeImport = async () => {
    if (!api) return;
    const selected = discoveredServers.filter((d) => selectedImports[d.id]);
    if (selected.length === 0) {
      setImportFeedback(t("mcp.noServersSelected"));
      return;
    }
    const res = await api.importServers(
      selected.map((s) => s.id),
      envKeyChoices,
      importEnvValues
    );
    if (res.ok) {
      setImportFeedback(t("mcp.importSuccess", { count: res.imported }));
      await loadData();
      setTimeout(() => setShowImport(false), 1500);
    } else {
      setImportFeedback(`Error: ${res.errors.join(", ")}`);
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
    } catch (e: any) {
      setEditorErrors([`Invalid JSON: ${e.message}`]);
      setEditorFeedback(null);
    }
  };

  const handleSaveRaw = async () => {
    if (!api) return;
    const res = await api.configSave(rawText);
    if (res.ok) {
      setEditorErrors([]);
      setEditorFeedback(t("mcp.configSaved"));
      await loadData();
    } else {
      setEditorErrors(res.errors);
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
            <Button variant="outline" size="sm" onClick={openGallery}>
              <Sparkles className="size-3.5" aria-hidden="true" />
              {t("mcp.galleryButton")}
            </Button>
            <Button variant="outline" size="sm" onClick={openImport}>
              <Download className="size-3.5" aria-hidden="true" />
              {t("mcp.importButton")}
            </Button>
          </div>
        </div>

        {/* Server List */}
        <SettingsPanel className="mt-4">
          {loading ? (
            <SettingsPanelRow>
              <p className="flex items-center gap-2 text-xs text-muted-foreground/80">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("common.loading")}
              </p>
            </SettingsPanelRow>
          ) : servers.length === 0 ? (
            <SettingsPanelRow>
              <div className="py-6 text-center">
                <Blocks className="mx-auto size-8 text-muted-foreground/50" />
                <h4 className="mt-2 text-xs font-medium text-foreground">{t("mcp.noServers")}</h4>
                <p className="mt-1 text-xs text-muted-foreground/80">{t("mcp.noServersHint")}</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button size="sm" onClick={openGallery}>
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
                            onClick={() => toggleTools(server.name)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {isExpanded ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
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
                              onClick={() => handleAuth(server.name)}
                            >
                              <KeyRound className="size-3.5" />
                              {t("mcp.signIn")}
                            </Button>
                          )}
                          {server.status === "connected" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => handleDisconnect(server.name)}
                            >
                              <CircleX className="size-3.5 text-rose-500" />
                              {t("mcp.disconnect")}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => handleConnect(server.name)}
                            >
                              <Play className="size-3.5 text-emerald-500" />
                              {t("mcp.connect")}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => handleTest(server.name)}
                          >
                            <RefreshCw className={`size-3.5 ${isBusy ? "animate-spin" : ""}`} />
                            {t("mcp.test")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => handleRemove(server.name)}
                            className="text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>

                      {testMsg && (
                        <div
                          className={`rounded px-2.5 py-1 text-xs ${
                            testMsg.startsWith("Success")
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : testMsg.startsWith("Error") || testMsg.startsWith("Test failed")
                              ? "bg-destructive/10 text-destructive"
                              : "bg-surface-2 text-muted-foreground"
                          }`}
                        >
                          {testMsg}
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
                                            <ShieldCheck className="size-3" />
                                            {t("mcp.readOnly")}
                                          </span>
                                        ) : isDestructive ? (
                                          <span className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-0.2 text-[10px] text-amber-600 dark:text-amber-400">
                                            <Shield className="size-3" />
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
                                      onChange={() =>
                                        handleToggleTool(server.name, tool.name, tool.enabled !== false)
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
                  <label className="text-xs font-medium text-foreground">{t("mcp.serverName")}</label>
                  <Input
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder={t("mcp.serverNamePlaceholder")}
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">{t("mcp.serverType")}</label>
                  <select
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
                    <label className="text-xs font-medium text-foreground">{t("mcp.command")}</label>
                    <Input
                      value={addCommand}
                      onChange={(e) => setAddCommand(e.target.value)}
                      placeholder="npx, node, python"
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-foreground">{t("mcp.args")}</label>
                    <Input
                      value={addArgs}
                      onChange={(e) => setAddArgs(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-filesystem C:\Docs"
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">{t("mcp.url")}</label>
                  <Input
                    value={addUrl}
                    onChange={(e) => setAddUrl(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}

              {addFeedback && (
                <div
                  className={`flex items-center gap-2 rounded px-3 py-2 text-xs ${
                    addFeedback.type === "success"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {addFeedback.type === "success" ? (
                    <CheckCircle2 className="size-4 shrink-0" />
                  ) : (
                    <AlertCircle className="size-4 shrink-0" />
                  )}
                  <span>{addFeedback.message}</span>
                </div>
              )}

              <Button type="submit" size="sm">
                <Plus className="size-3.5" aria-hidden="true" />
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
                      <ShieldCheck className="size-4 text-emerald-500" />
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
                    <Trash2 className="size-3.5" />
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
                  <Button variant="outline" size="sm" onClick={handleValidateRaw}>
                    {t("common.validate")}
                  </Button>
                  <Button size="sm" onClick={handleSaveRaw}>
                    {t("common.save")}
                  </Button>
                </div>
              </div>

              {editorFeedback && (
                <div className="flex items-center gap-2 rounded bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-4" />
                  <span>{editorFeedback}</span>
                </div>
              )}

              {editorErrors.length > 0 && (
                <div className="rounded bg-destructive/10 p-3 text-xs text-destructive">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertCircle className="size-4" />
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

      {/* Saved Permissions Panel */}
      <div>
        <SectionHeader
          title={t("mcp.permissionsTitle", { defaultValue: "Saved Permissions" })}
          description={t("mcp.permissionsDescription", {
            defaultValue: "Actions and MCP tools previously authorized to 'Always allow'. You can revoke permissions at any time.",
          })}
        />
        <SettingsPanel className="mt-4">
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
                      <ShieldCheck className="size-4 text-emerald-500" />
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
                    <Trash2 className="size-3.5" />
                    {t("mcp.revoke", { defaultValue: "Revoke" })}
                  </Button>
                </div>
              </SettingsPanelRow>
            ))
          )}
        </SettingsPanel>
      </div>

      {/* Gallery Modal */}
      {showGallery && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{t("mcp.galleryModalTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("mcp.galleryModalDescription")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowGallery(false)}>
                ✕
              </Button>
            </div>
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
                    onClick={() => addFromGallery(item)}
                  >
                    <Plus className="size-3.5" />
                    {t("mcp.addFromGallery")}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{t("mcp.importModalTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("mcp.importModalDescription")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowImport(false)}>
                ✕
              </Button>
            </div>

            <div className="mt-4 space-y-3">
              {discoveredServers.length === 0 ? (
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
                            <AlertCircle className="size-3" />
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
                <p className="mt-2 text-xs font-medium text-foreground">{importFeedback}</p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowImport(false)}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" onClick={executeImport} disabled={discoveredServers.length === 0}>
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

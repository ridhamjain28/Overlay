import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "../icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { IntegrationsPane } from "./IntegrationsPane";
import { useSettingsStore } from "../../stores/settingsStore";
import { ensureConnectorStatus, useConnectorStatusStore } from "../../stores/connectorStatusStore";
import { APP_REGISTRY, getAppRegistry } from "../../helpers/apps/appRegistry";

import googleCalendarIcon from "../../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../../assets/icons/microsoft-calendar.webp";
import appleCalendarIcon from "../../assets/icons/apple-calendar.svg";
import gmailIcon from "../../assets/icons/gmail.svg";
import slackIcon from "../../assets/icons/slack.svg";
import linearIcon from "../../assets/icons/linear.svg";
import githubIcon from "../../assets/icons/github.svg";

const ICONS: Record<string, string> = {
  "google-calendar": googleCalendarIcon,
  "microsoft-calendar": microsoftCalendarIcon,
  "apple-calendar": appleCalendarIcon,
  gmail: gmailIcon,
  slack: slackIcon,
  linear: linearIcon,
  github: githubIcon,
};

interface ConnectAppsPaneProps {
  title: string;
}

export function ConnectAppsPane({ title }: ConnectAppsPaneProps): ReactElement {
  const { t } = useTranslation();
  const isMac = typeof window !== "undefined" && window.electronAPI?.getPlatform?.() === "darwin";
  const apps = getAppRegistry({ platform: isMac ? "darwin" : "win32" });

  const {
    gcalAccounts,
    setGcalAccounts,
    mcalAccounts,
    setMcalAccounts,
    appleCalendarConnected,
    setAppleCalendarConnected,
  } = useSettingsStore();

  const connectorStatuses = useConnectorStatusStore((state) => state.statuses);

  const [connectingAppId, setConnectingAppId] = useState<string | null>(null);
  const [disconnectingAppId, setDisconnectingAppId] = useState<string | null>(null);
  const [appConfigs, setAppConfigs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void ensureConnectorStatus();
    window.electronAPI?.overlayGetAppConfigs?.().then((configs) => {
      if (configs) setAppConfigs(configs);
    }).catch(() => {});
  }, []);

  const handleConnect = async (appId: string) => {
    setConnectingAppId(appId);
    try {
      if (appId === "google-calendar") {
        const result = await window.electronAPI?.gcalStartOAuth?.();
        if (result?.success && result.email) {
          const current = useSettingsStore.getState().gcalAccounts;
          setGcalAccounts([
            ...current.filter((a) => a.email !== result.email),
            { email: result.email },
          ]);
        }
      } else if (appId === "microsoft-calendar") {
        const result = await window.electronAPI?.mcalStartOAuth?.();
        if (result?.success && result.email) {
          const current = useSettingsStore.getState().mcalAccounts;
          setMcalAccounts([
            ...current.filter((a) => a.email !== result.email),
            { email: result.email, tenantId: result.tenantId },
          ]);
        }
      } else if (appId === "apple-calendar") {
        const result = await window.electronAPI?.acalConnect?.();
        if (result?.success) {
          setAppleCalendarConnected(true);
        }
      } else {
        await window.electronAPI?.connectorConnect?.(appId);
      }
    } finally {
      setConnectingAppId(null);
    }
  };

  const handleDisconnect = async (appId: string) => {
    setDisconnectingAppId(appId);
    try {
      if (appId === "google-calendar") {
        await window.electronAPI?.gcalDisconnect?.();
        setGcalAccounts([]);
      } else if (appId === "microsoft-calendar") {
        await window.electronAPI?.mcalDisconnect?.();
        setMcalAccounts([]);
      } else if (appId === "apple-calendar") {
        await window.electronAPI?.acalDisconnect?.();
        setAppleCalendarConnected(false);
      } else {
        await window.electronAPI?.connectorDisconnect?.(appId);
      }
    } finally {
      setDisconnectingAppId(null);
    }
  };

  return (
    <IntegrationsPane
      title={title}
      description={t(
        "integrations.apps.description",
        "Connect the apps you use every day with simple, one-click sign in."
      )}
    >
      <SettingsPanel>
        {apps.map((app) => {
          const iconSrc = ICONS[app.icon] || ICONS[app.id];
          const configured = app.isConfigured({
            appConfigs,
            connectorStatuses,
            platform: isMac ? "darwin" : "win32",
          });
          const status = app.getStatus({
            settings: {
              gcalAccounts,
              mcalAccounts,
              appleCalendarConnected,
            },
            connectorStatuses,
          });

          const isConnecting = connectingAppId === app.id;
          const isDisconnecting = disconnectingAppId === app.id;

          return (
            <SettingsPanelRow key={app.id}>
              <div className="flex items-center gap-3 w-full">
                <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/10 flex items-center justify-center shrink-0">
                  {iconSrc ? (
                    <img
                      src={iconSrc}
                      alt=""
                      aria-hidden="true"
                      className="w-5 h-5 object-contain"
                    />
                  ) : (
                    <span className="text-xs font-bold text-muted-foreground">
                      {app.name.charAt(0)}
                    </span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-foreground">{app.name}</p>
                    {status.connected && (
                      <Badge variant="success" className="shrink-0 text-[10px] py-0 px-1.5 h-4">
                        {t("integrations.apps.connected", "Connected")}
                      </Badge>
                    )}
                    {!configured && (
                      <Badge variant="secondary" className="shrink-0 text-[10px] py-0 px-1.5 h-4 opacity-75">
                        {t("integrations.apps.notConfigured", "Not available in this build yet")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                    {app.description}
                  </p>
                  {status.connected && status.accountLabel && (
                    <p className="text-[11px] text-muted-foreground/60 mt-0.5 truncate">
                      {status.accountLabel}
                    </p>
                  )}
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  {!configured ? (
                    <Button size="sm" variant="outline" disabled className="text-xs h-7 opacity-60">
                      {t("integrations.apps.unavailable", "Unavailable")}
                    </Button>
                  ) : status.connected ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDisconnect(app.id)}
                      disabled={isDisconnecting}
                      className="text-xs h-7 hover:text-destructive hover:border-destructive/30"
                    >
                      {isDisconnecting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        t("integrations.apps.disconnect", "Disconnect")
                      )}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleConnect(app.id)}
                      disabled={isConnecting}
                      className="text-xs h-7"
                    >
                      {isConnecting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        t("integrations.apps.connect", "Connect")
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </SettingsPanelRow>
          );
        })}
      </SettingsPanel>
    </IntegrationsPane>
  );
}

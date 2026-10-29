// Overlay: data-driven connectable apps registry.
// Describes each connectable third-party app: id, name, icon identifier,
// required OAuth/permission scopes, env vars, descriptions, and
// connect / disconnect / status handlers.
//
// Adding a new connectable app in the future only requires appending its
// entry to this registry file; no UI rewrites required.

const APP_REGISTRY = [
  {
    id: "google-calendar",
    name: "Google Calendar",
    icon: "google-calendar",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    envVars: ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"],
    description: "Sync your schedule, view meeting details, and add calendar events.",
    category: "calendar",
    isConfigured: ({ env, appConfigs } = {}) => {
      if (appConfigs && typeof appConfigs["google-calendar"] === "boolean") {
        return appConfigs["google-calendar"];
      }
      return Boolean(env?.GOOGLE_CALENDAR_CLIENT_ID);
    },
    getStatus: ({ settings } = {}) => {
      const accounts = settings?.gcalAccounts || [];
      const connected = accounts.length > 0;
      return {
        connected,
        accountLabel: accounts.map((a) => a.email).filter(Boolean).join(", ") || null,
        accounts,
      };
    },
    connect: async (api) => {
      if (!api?.gcalStartOAuth) throw new Error("gcalStartOAuth not available");
      return api.gcalStartOAuth();
    },
    disconnect: async (api, { accountEmail } = {}) => {
      if (!api?.gcalDisconnect) throw new Error("gcalDisconnect not available");
      return api.gcalDisconnect(accountEmail);
    },
  },
  {
    id: "microsoft-calendar",
    name: "Microsoft Outlook",
    icon: "microsoft-calendar",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Calendars.Read",
      "https://graph.microsoft.com/Calendars.ReadWrite",
    ],
    envVars: ["MICROSOFT_CALENDAR_CLIENT_ID"],
    description: "Access your Outlook calendar, sync meetings, and schedule events.",
    category: "calendar",
    isConfigured: ({ env, appConfigs } = {}) => {
      if (appConfigs && typeof appConfigs["microsoft-calendar"] === "boolean") {
        return appConfigs["microsoft-calendar"];
      }
      return Boolean(env?.MICROSOFT_CALENDAR_CLIENT_ID);
    },
    getStatus: ({ settings } = {}) => {
      const accounts = settings?.mcalAccounts || [];
      const connected = accounts.length > 0;
      return {
        connected,
        accountLabel: accounts.map((a) => a.email).filter(Boolean).join(", ") || null,
        accounts,
      };
    },
    connect: async (api) => {
      if (!api?.mcalStartOAuth) throw new Error("mcalStartOAuth not available");
      return api.mcalStartOAuth();
    },
    disconnect: async (api, { accountEmail } = {}) => {
      if (!api?.mcalDisconnect) throw new Error("mcalDisconnect not available");
      return api.mcalDisconnect(accountEmail);
    },
  },
  {
    id: "apple-calendar",
    name: "Apple Calendar",
    icon: "apple-calendar",
    scopes: ["calendar:eventKit"],
    envVars: [],
    platform: "darwin",
    description: "Sync upcoming meetings and events directly with Apple Calendar on macOS.",
    category: "calendar",
    isConfigured: ({ platform } = {}) => {
      return (platform || process.platform) === "darwin";
    },
    getStatus: ({ settings } = {}) => {
      const connected = Boolean(settings?.appleCalendarConnected);
      return {
        connected,
        accountLabel: connected ? "macOS Calendar" : null,
      };
    },
    connect: async (api) => {
      if (!api?.acalConnect) throw new Error("acalConnect not available");
      return api.acalConnect();
    },
    disconnect: async (api) => {
      if (!api?.acalDisconnect) throw new Error("acalDisconnect not available");
      return api.acalDisconnect();
    },
  },
  {
    id: "gmail",
    name: "Gmail",
    icon: "gmail",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    envVars: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"],
    description: "Send email drafts and create messages directly from Overlay.",
    category: "communication",
    isConfigured: ({ connectorStatuses } = {}) => {
      return connectorStatuses?.gmail?.configured !== false;
    },
    getStatus: ({ connectorStatuses } = {}) => {
      const s = connectorStatuses?.gmail;
      return {
        connected: Boolean(s?.connected),
        accountLabel: s?.accountLabel || null,
        needsReconnect: Boolean(s?.needsReconnect),
      };
    },
    connect: async (api) => {
      if (!api?.connectorConnect) throw new Error("connectorConnect not available");
      return api.connectorConnect("gmail");
    },
    disconnect: async (api) => {
      if (!api?.connectorDisconnect) throw new Error("connectorDisconnect not available");
      return api.connectorDisconnect("gmail");
    },
  },
  {
    id: "slack",
    name: "Slack",
    icon: "slack",
    scopes: [
      "chat:write",
      "channels:read",
      "groups:read",
      "im:write",
      "users:read",
      "users:read.email",
    ],
    envVars: ["SLACK_CLIENT_ID"],
    description: "Post updates to channels and send direct messages to your team.",
    category: "communication",
    isConfigured: ({ connectorStatuses } = {}) => {
      return connectorStatuses?.slack?.configured !== false;
    },
    getStatus: ({ connectorStatuses } = {}) => {
      const s = connectorStatuses?.slack;
      const account = s?.accountLabel || "";
      const workspace = s?.workspaceLabel ? ` (${s.workspaceLabel})` : "";
      return {
        connected: Boolean(s?.connected),
        accountLabel: account ? `${account}${workspace}` : null,
        needsReconnect: Boolean(s?.needsReconnect),
      };
    },
    connect: async (api) => {
      if (!api?.connectorConnect) throw new Error("connectorConnect not available");
      return api.connectorConnect("slack");
    },
    disconnect: async (api) => {
      if (!api?.connectorDisconnect) throw new Error("connectorDisconnect not available");
      return api.connectorDisconnect("slack");
    },
  },
  {
    id: "linear",
    name: "Linear",
    icon: "linear",
    scopes: ["read", "write", "issues:create", "comments:create"],
    envVars: ["LINEAR_CLIENT_ID"],
    description: "Create issues and track project updates without switching apps.",
    category: "productivity",
    isConfigured: ({ connectorStatuses } = {}) => {
      return connectorStatuses?.linear?.configured !== false;
    },
    getStatus: ({ connectorStatuses } = {}) => {
      const s = connectorStatuses?.linear;
      const account = s?.accountLabel || "";
      const workspace = s?.workspaceLabel ? ` (${s.workspaceLabel})` : "";
      return {
        connected: Boolean(s?.connected),
        accountLabel: account ? `${account}${workspace}` : null,
        needsReconnect: Boolean(s?.needsReconnect),
      };
    },
    connect: async (api) => {
      if (!api?.connectorConnect) throw new Error("connectorConnect not available");
      return api.connectorConnect("linear");
    },
    disconnect: async (api) => {
      if (!api?.connectorDisconnect) throw new Error("connectorDisconnect not available");
      return api.connectorDisconnect("linear");
    },
  },
  {
    id: "github",
    name: "GitHub",
    icon: "github",
    scopes: ["issues:write", "repo"],
    envVars: ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_SLUG"],
    description: "Create issues and reference repositories in your assistant chat.",
    category: "developer",
    isConfigured: ({ connectorStatuses } = {}) => {
      return connectorStatuses?.github?.configured !== false;
    },
    getStatus: ({ connectorStatuses } = {}) => {
      const s = connectorStatuses?.github;
      return {
        connected: Boolean(s?.connected),
        accountLabel: s?.accountLabel || null,
        needsReconnect: Boolean(s?.needsReconnect),
      };
    },
    connect: async (api) => {
      if (!api?.connectorConnect) throw new Error("connectorConnect not available");
      return api.connectorConnect("github");
    },
    disconnect: async (api) => {
      if (!api?.connectorDisconnect) throw new Error("connectorDisconnect not available");
      return api.connectorDisconnect("github");
    },
  },
];

function getAppRegistry({ platform } = {}) {
  const currentPlatform = platform || (typeof process !== "undefined" ? process.platform : "win32");
  return APP_REGISTRY.filter((app) => !app.platform || app.platform === currentPlatform);
}

function findApp(id) {
  return APP_REGISTRY.find((app) => app.id === id) || null;
}

// ES module exports so the renderer (Vite) can import it; tests load it via tsx.
export { APP_REGISTRY, getAppRegistry, findApp };

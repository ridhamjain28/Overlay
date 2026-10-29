const test = require("node:test");
const assert = require("node:assert/strict");
const { APP_REGISTRY, getAppRegistry, findApp } = require("../../src/helpers/apps/appRegistry.js");

test("registry shape: all expected apps exist with correct properties", () => {
  assert.ok(Array.isArray(APP_REGISTRY), "APP_REGISTRY should be an array");
  const expectedApps = [
    "google-calendar",
    "microsoft-calendar",
    "apple-calendar",
    "gmail",
    "slack",
    "linear",
    "github",
  ];

  for (const id of expectedApps) {
    const app = findApp(id);
    assert.ok(app, `App ${id} should exist in registry`);
    assert.equal(typeof app.name, "string", `${id} has string name`);
    assert.equal(typeof app.icon, "string", `${id} has string icon`);
    assert.equal(typeof app.description, "string", `${id} has description`);
    assert.ok(Array.isArray(app.scopes), `${id} has array of scopes`);
    assert.ok(app.scopes.length > 0, `${id} scopes are not empty`);
    assert.ok(Array.isArray(app.envVars), `${id} has array of envVars`);
    assert.equal(typeof app.isConfigured, "function", `${id} has isConfigured function`);
    assert.equal(typeof app.getStatus, "function", `${id} has getStatus function`);
    assert.equal(typeof app.connect, "function", `${id} has connect function`);
    assert.equal(typeof app.disconnect, "function", `${id} has disconnect function`);
  }
});

test("platform filtering: apple-calendar is present on darwin and excluded on win32", () => {
  const darwinApps = getAppRegistry({ platform: "darwin" });
  assert.ok(darwinApps.some((a) => a.id === "apple-calendar"));

  const winApps = getAppRegistry({ platform: "win32" });
  assert.ok(!winApps.some((a) => a.id === "apple-calendar"));
});

test("isConfigured: reflects env vars, appConfigs, and connector status", () => {
  const gcal = findApp("google-calendar");
  assert.equal(gcal.isConfigured({ env: {} }), false);
  assert.equal(gcal.isConfigured({ env: { GOOGLE_CALENDAR_CLIENT_ID: "abc" } }), true);
  assert.equal(gcal.isConfigured({ appConfigs: { "google-calendar": true } }), true);
  assert.equal(gcal.isConfigured({ appConfigs: { "google-calendar": false } }), false);

  const mcal = findApp("microsoft-calendar");
  assert.equal(mcal.isConfigured({ env: {} }), false);
  assert.equal(mcal.isConfigured({ env: { MICROSOFT_CALENDAR_CLIENT_ID: "xyz" } }), true);
  assert.equal(mcal.isConfigured({ appConfigs: { "microsoft-calendar": true } }), true);

  const slack = findApp("slack");
  assert.equal(slack.isConfigured({ connectorStatuses: { slack: { configured: false } } }), false);
  assert.equal(slack.isConfigured({ connectorStatuses: { slack: { configured: true } } }), true);
});

test("getStatus: correctly parses connected and account information", () => {
  const gcal = findApp("google-calendar");
  const disconnectedStatus = gcal.getStatus({ settings: { gcalAccounts: [] } });
  assert.equal(disconnectedStatus.connected, false);

  const connectedStatus = gcal.getStatus({
    settings: { gcalAccounts: [{ email: "user@example.com" }] },
  });
  assert.equal(connectedStatus.connected, true);
  assert.equal(connectedStatus.accountLabel, "user@example.com");

  const slack = findApp("slack");
  const slackStatus = slack.getStatus({
    connectorStatuses: {
      slack: { connected: true, accountLabel: "U123", workspaceLabel: "Work" },
    },
  });
  assert.equal(slackStatus.connected, true);
  assert.equal(slackStatus.accountLabel, "U123 (Work)");
});

test("connect and disconnect handlers call underlying Electron bridges", async () => {
  const calls = [];
  const fakeApi = {
    gcalStartOAuth: async () => {
      calls.push("gcal-connect");
      return { success: true, email: "g@example.com" };
    },
    gcalDisconnect: async (email) => {
      calls.push(`gcal-disconnect:${email}`);
      return { success: true };
    },
    connectorConnect: async (id) => {
      calls.push(`connector-connect:${id}`);
      return { status: "connected" };
    },
    connectorDisconnect: async (id) => {
      calls.push(`connector-disconnect:${id}`);
      return { status: "disconnected" };
    },
  };

  const gcal = findApp("google-calendar");
  const gcalRes = await gcal.connect(fakeApi);
  assert.equal(gcalRes.success, true);
  assert.equal(calls[0], "gcal-connect");

  await gcal.disconnect(fakeApi, { accountEmail: "g@example.com" });
  assert.equal(calls[1], "gcal-disconnect:g@example.com");

  const slack = findApp("slack");
  await slack.connect(fakeApi);
  assert.equal(calls[2], "connector-connect:slack");

  await slack.disconnect(fakeApi);
  assert.equal(calls[3], "connector-disconnect:slack");
});

test("existing calendar scopes remain intact", () => {
  const gcal = findApp("google-calendar");
  assert.ok(
    gcal.scopes.includes("https://www.googleapis.com/auth/calendar.events.readonly"),
    "Google Calendar includes readonly scope"
  );
  assert.ok(
    gcal.scopes.includes("https://www.googleapis.com/auth/calendar.events"),
    "Google Calendar includes events scope for adding events"
  );

  const mcal = findApp("microsoft-calendar");
  assert.ok(
    mcal.scopes.includes("https://graph.microsoft.com/Calendars.Read"),
    "Microsoft Calendar includes read scope"
  );
  assert.ok(
    mcal.scopes.includes("https://graph.microsoft.com/Calendars.ReadWrite"),
    "Microsoft Calendar includes write scope"
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { scanInstalledApps, appFromStartApp, appFromAppPath, appFromProtocol } = require("../../src/helpers/overlay/appInventory");

test("scanInstalledApps uses mocked Start Menu, App Paths, UWP and protocols", async () => {
  const stages = [];
  const result = await scanInstalledApps({
    now: "2026-11-23T11:00:00.000Z",
    onProgress: (p) => stages.push(p.phase),
    shortcuts: [{ name: "google chrome", path: "C:\\\\ProgramData\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Chrome.lnk" }],
    readShortcutLink: () => ({ target: "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe" }),
    appPaths: [{ exe: "code.exe", path: "C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe" }],
    startApps: [{ Name: "Spotify", AppID: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" }],
    protocols: [{ protocol: "whatsapp", command: "WhatsApp.exe %1" }],
    execFile: async () => {
      throw new Error("execFile should not be used when sources are injected");
    },
  });
  assert.equal(result.scannedAt, "2026-11-23T11:00:00.000Z");
  const bySource = Object.fromEntries(result.apps.map((app) => [app.source, app]));
  assert.equal(bySource.start_menu.exeName, "chrome.exe");
  assert.match(bySource.start_menu.target, /chrome\.exe$/i);
  assert.equal(bySource.app_paths.exeName, "code.exe");
  assert.equal(bySource.start_apps.aumid, "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify");
  assert.deepEqual(bySource.protocol.protocols, ["whatsapp:"]);
  assert.ok(stages.includes("shortcuts"));
  assert.ok(stages.includes("protocols"));
});

test("helpers map registry and Get-StartApps rows", () => {
  const start = appFromStartApp({ Name: "Settings", AppID: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel" });
  assert.equal(start.type, "uwp");
  assert.match(start.aumid, /immersivecontrolpanel/i);
  const pathRow = appFromAppPath({ exe: "notepad.exe", path: "C:\\\\Windows\\\\System32\\\\notepad.exe" });
  assert.equal(pathRow.exeName, "notepad.exe");
  const proto = appFromProtocol({ protocol: "ms-settings" });
  assert.deepEqual(proto.protocols, ["ms-settings:"]);
});

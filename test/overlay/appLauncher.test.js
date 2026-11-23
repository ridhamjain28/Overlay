const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLaunchIndex,
  resolveApp,
  launchApp,
  scoreMatch,
} = require("../../src/helpers/overlay/appLauncher");

// Realistic fixture data representing the 4 Windows app discovery sources
const FIXTURE_SHORTCUTS = [
  { name: "Google Chrome", path: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk" },
  { name: "Visual Studio Code", path: "C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk" },
  { name: "Slack", path: "C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Slack.lnk" },
  { name: "Discord", path: "C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Discord.lnk" },
  { name: "Uninstall Tool", path: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Uninstall Tool.lnk" }, // should be blocked/skipped
];

const FIXTURE_APP_PATHS = [
  { exe: "notepad++.exe", path: "C:\\Program Files\\Notepad++\\notepad++.exe" },
  { exe: "firefox.exe", path: "C:\\Program Files\\Mozilla Firefox\\firefox.exe" },
  { exe: "vlc.exe", path: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" },
];

const FIXTURE_START_APPS = [
  {
    Name: "Lenovo Vantage",
    AppID: "E046963F.LenovoCompanion_k1h2ywsp1082j!App",
  },
  {
    Name: "Spotify",
    AppID: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify",
  },
  {
    Name: "Microsoft To Do",
    AppID: "Microsoft.Todos_8wekyb3d8bbwe!App",
  },
  {
    Name: "Windows Terminal",
    AppID: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
  },
];

const FIXTURE_PROTOCOLS = [
  { protocol: "zoommtg", command: "\"C:\\Users\\User\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe\" --url=\"%1\"" },
  { protocol: "tg", command: "\"C:\\Users\\User\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe\" -- \"%1\"" },
  { protocol: "spotify", command: "\"C:\\Users\\User\\AppData\\Roaming\\Spotify\\Spotify.exe\" --uri=\"%1\"" },
];

test("buildLaunchIndex combines all sources into unified entries", () => {
  const index = buildLaunchIndex({
    shortcuts: FIXTURE_SHORTCUTS,
    appPaths: FIXTURE_APP_PATHS,
    startApps: FIXTURE_START_APPS,
    protocols: FIXTURE_PROTOCOLS,
  });

  assert.ok(Array.isArray(index));
  assert.ok(index.length >= 10);

  // Checks that built-ins exist
  const notepad = index.find((e) => e.appId === "notepad");
  assert.ok(notepad);
  assert.equal(notepad.launch.type, "exe");
  assert.equal(notepad.launch.target, "notepad.exe");

  // Checks shortcut app
  const chrome = index.find((e) => e.name === "Google Chrome");
  assert.ok(chrome);
  assert.equal(chrome.launch.type, "shortcut");
  assert.match(chrome.launch.target, /Google Chrome\.lnk$/);

  // Checks App Paths app
  const npp = index.find((e) => e.name === "notepad++");
  assert.ok(npp);
  assert.equal(npp.launch.type, "exe");
  assert.match(npp.launch.target, /notepad\+\+\.exe$/i);

  // Checks Store / UWP AUMID app
  const vantage = index.find((e) => e.name === "Lenovo Vantage");
  assert.ok(vantage);
  assert.equal(vantage.launch.type, "shell");
  assert.equal(vantage.launch.target, "shell:AppsFolder\\E046963F.LenovoCompanion_k1h2ywsp1082j!App");

  // Checks protocol
  const zoom = index.find((e) => e.name === "zoommtg");
  assert.ok(zoom);
  assert.equal(zoom.launch.type, "uri");
  assert.equal(zoom.launch.target, "zoommtg:");
});

test("resolveApp matches 'vantage' fuzzy alias to Lenovo Vantage with score and shell launch target", () => {
  const index = buildLaunchIndex({
    shortcuts: FIXTURE_SHORTCUTS,
    appPaths: FIXTURE_APP_PATHS,
    startApps: FIXTURE_START_APPS,
    protocols: FIXTURE_PROTOCOLS,
  });

  const res = resolveApp("vantage", { index });
  assert.ok(res, "Should resolve 'vantage'");
  assert.equal(res.name, "Lenovo Vantage");
  assert.equal(res.appId, "lenovo-vantage");
  assert.equal(res.launch.type, "shell");
  assert.equal(res.launch.target, "shell:AppsFolder\\E046963F.LenovoCompanion_k1h2ywsp1082j!App");
  assert.ok(res.score >= 0.8, `Score was ${res.score}`);
});

test("resolveApp matches 'spotify' to Spotify Store app", () => {
  const index = buildLaunchIndex({
    shortcuts: FIXTURE_SHORTCUTS,
    appPaths: FIXTURE_APP_PATHS,
    startApps: FIXTURE_START_APPS,
    protocols: FIXTURE_PROTOCOLS,
  });

  const res = resolveApp("spotify", { index });
  assert.ok(res, "Should resolve 'spotify'");
  assert.equal(res.name, "Spotify");
  assert.equal(res.launch.type, "shell");
  assert.equal(res.launch.target, "shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify");
  assert.ok(res.score >= 0.9);
});

test("resolveApp matches aliases: 'code' -> Visual Studio Code, 'calc' -> Calculator", () => {
  const index = buildLaunchIndex({
    shortcuts: FIXTURE_SHORTCUTS,
    appPaths: FIXTURE_APP_PATHS,
    startApps: FIXTURE_START_APPS,
    protocols: FIXTURE_PROTOCOLS,
  });

  const codeRes = resolveApp("code", { index });
  assert.ok(codeRes);
  assert.equal(codeRes.name, "Visual Studio Code");
  assert.equal(codeRes.launch.type, "shortcut");

  const calcRes = resolveApp("calc", { index });
  assert.ok(calcRes);
  assert.equal(calcRes.name, "Calculator");
  assert.equal(calcRes.launch.type, "exe");
  assert.equal(calcRes.launch.target, "calc.exe");
});

test("resolveApp returns null for unknown apps or blocked queries", () => {
  const index = buildLaunchIndex({
    shortcuts: FIXTURE_SHORTCUTS,
    appPaths: FIXTURE_APP_PATHS,
    startApps: FIXTURE_START_APPS,
    protocols: FIXTURE_PROTOCOLS,
  });

  assert.equal(resolveApp("totally-non-existent-app-xyz", { index }), null);
  assert.equal(resolveApp("", { index }), null);
  assert.equal(resolveApp(null, { index }), null);
});

test("launchApp invokes explorer.exe for Store / UWP shell apps", async () => {
  const executed = [];
  const mockExecFile = (file, args, opts, cb) => {
    executed.push({ file, args, opts });
    if (typeof cb === "function") cb(null);
  };

  const resolved = {
    appId: "lenovo-vantage",
    name: "Lenovo Vantage",
    launch: {
      type: "shell",
      target: "shell:AppsFolder\\E046963F.LenovoCompanion_k1h2ywsp1082j!App",
    },
    score: 0.95,
  };

  const result = await launchApp(resolved, { execFile: mockExecFile });
  assert.deepEqual(result, { ok: true });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].file, "explorer.exe");
  assert.deepEqual(executed[0].args, ["shell:AppsFolder\\E046963F.LenovoCompanion_k1h2ywsp1082j!App"]);
});

test("launchApp invokes openExternal for uri protocols", async () => {
  const uris = [];
  const mockOpenExternal = async (url) => {
    uris.push(url);
  };

  const resolved = {
    appId: "zoommtg",
    name: "zoommtg",
    launch: {
      type: "uri",
      target: "zoommtg:",
    },
    score: 1.0,
  };

  const result = await launchApp(resolved, { openExternal: mockOpenExternal });
  assert.deepEqual(result, { ok: true });
  assert.equal(uris.length, 1);
  assert.equal(uris[0], "zoommtg:");
});

test("launchApp invokes openPath for shortcuts", async () => {
  const paths = [];
  const mockOpenPath = async (p) => {
    paths.push(p);
    return "";
  };

  const resolved = {
    appId: "google-chrome",
    name: "Google Chrome",
    launch: {
      type: "shortcut",
      target: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk",
    },
    score: 1.0,
  };

  const result = await launchApp(resolved, { openPath: mockOpenPath });
  assert.deepEqual(result, { ok: true });
  assert.equal(paths.length, 1);
  assert.equal(paths[0], "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk");
});

test("launchApp invokes execFile for normal exes", async () => {
  const executed = [];
  const mockExecFile = (file, args, opts, cb) => {
    executed.push({ file, args, opts });
    if (typeof cb === "function") cb(null);
  };

  const resolved = {
    appId: "notepad",
    name: "Notepad",
    launch: {
      type: "exe",
      target: "notepad.exe",
    },
    score: 1.0,
  };

  const result = await launchApp(resolved, { execFile: mockExecFile });
  assert.deepEqual(result, { ok: true });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].file, "notepad.exe");
});

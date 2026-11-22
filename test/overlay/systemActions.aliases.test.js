const test = require("node:test");
const assert = require("node:assert/strict");
const sa = require("../../src/helpers/overlay/systemActions.js");

const shortcuts = [
  { name: "google chrome", path: "C:\\Chrome.lnk" },
  { name: "microsoft edge", path: "C:\\Edge.lnk" },
  { name: "visual studio code", path: "C:\\Code.lnk" },
  { name: "word", path: "C:\\Word.lnk" },
  { name: "excel", path: "C:\\Excel.lnk" },
  { name: "spotify", path: "C:\\Spotify.lnk" },
  { name: "whatsapp", path: "C:\\WhatsApp.lnk" },
];

test("fuzzy aliases resolve nordpad and note pad to Notepad", () => {
  for (const name of ["nordpad", "Nordpad", "note pad", "notepad"]) {
    const app = sa.resolveApp(name, { shortcuts });
    assert.ok(app, name);
    assert.equal(app.type, "exe", name);
    assert.equal(app.target, "notepad.exe", name);
  }
});

test("aliases resolve calc, explorer, chrome, edge, vs code, settings, word, excel, spotify, whatsapp", () => {
  const cases = [
    ["calc", { type: "exe", target: "calc.exe" }],
    ["calculator", { type: "exe", target: "calc.exe" }],
    ["file explorer", { type: "exe", target: "explorer.exe" }],
    ["explorer", { type: "exe", target: "explorer.exe" }],
    ["settings", { type: "uri", target: "ms-settings:" }],
    ["chrome", { type: "shortcut", target: "C:\\Chrome.lnk" }],
    ["edge", { type: "shortcut", target: "C:\\Edge.lnk" }],
    ["vs code", { type: "shortcut", target: "C:\\Code.lnk" }],
    ["code", { type: "shortcut", target: "C:\\Code.lnk" }],
    ["vscode", { type: "shortcut", target: "C:\\Code.lnk" }],
    ["word", { type: "shortcut", target: "C:\\Word.lnk" }],
    ["excel", { type: "shortcut", target: "C:\\Excel.lnk" }],
    ["spotify", { type: "shortcut", target: "C:\\Spotify.lnk" }],
    ["whatsapp", { type: "shortcut", target: "C:\\WhatsApp.lnk" }],
  ];
  for (const [name, expected] of cases) {
    const app = sa.resolveApp(name, { shortcuts });
    assert.ok(app, name);
    assert.equal(app.type, expected.type, name);
    assert.equal(app.target, expected.target, name);
  }
});
const test = require("node:test");
const assert = require("node:assert/strict");
const { fillActionTemplate, sanitizeCliArg, validateParams } = require("../../src/helpers/overlay/appSkillTemplates");

test("URI and URL templates encode query values", () => {
  const uri = fillActionTemplate(
    { params: [{ name: "query", required: true }], how: { type: "uri", template: "spotify:search:{query}" } },
    { query: "star boy" }
  );
  assert.equal(uri.ok, true);
  assert.equal(uri.value, "spotify:search:star%20boy");

  const url = fillActionTemplate(
    { params: [{ name: "query", required: true }], how: { type: "url", template: "https://www.youtube.com/results?search_query={query}" } },
    { query: "lo-fi beats" }
  );
  assert.equal(url.value, "https://www.youtube.com/results?search_query=lo-fi%20beats");
});

test("CLI templates stay injection-safe", () => {
  const ok = fillActionTemplate(
    { params: [], how: { type: "cli", template: "{target}" } },
    { target: "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe" }
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.exe, "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe");
  assert.deepEqual(ok.args, []);
  assert.throws(() => sanitizeCliArg("foo & calc.exe"), /unsafe/);
  const bad = fillActionTemplate(
    { params: [{ name: "query", required: false }], how: { type: "cli", template: "code {query}" } },
    { query: "x && shutdown /s" }
  );
  assert.equal(bad.ok, false);
});

test("required params and safe key allow-list are enforced", () => {
  const missing = validateParams({ params: [{ name: "query", required: true }] }, {});
  assert.equal(missing.ok, false);
  const keys = fillActionTemplate({ params: [], how: { type: "keys", template: "MediaPlayPause" } }, {});
  assert.equal(keys.ok, true);
  const unsafe = fillActionTemplate({ params: [], how: { type: "keys", template: "Win+R" } }, {});
  assert.equal(unsafe.ok, false);
});

test("Office ofe/ofv document URIs keep colon and slash unescaped", () => {
  const url = "https://contoso.sharepoint.com/sites/team/doc.docx";
  const ofe = fillActionTemplate(
    { params: [{ name: "url", required: true }], how: { type: "uri", template: "ms-word:ofe|u|{url}" } },
    { url }
  );
  assert.equal(ofe.ok, true);
  assert.equal(ofe.value, "ms-word:ofe|u|https://contoso.sharepoint.com/sites/team/doc.docx");
  assert.equal(ofe.value.includes("%3A") || ofe.value.includes("%2F"), false);

  const ofv = fillActionTemplate(
    { params: [{ name: "url", required: true }], how: { type: "uri", template: "ms-excel:ofv|u|{url}" } },
    { url: "https://contoso.sharepoint.com/sites/team/sheet.xlsx" }
  );
  assert.equal(ofv.value, "ms-excel:ofv|u|https://contoso.sharepoint.com/sites/team/sheet.xlsx");

  const marked = fillActionTemplate(
    { params: [{ name: "url", required: true }], how: { type: "uri", template: "onenote:{url:raw}" } },
    { url: "https://contoso.sharepoint.com/notebooks/work" }
  );
  assert.equal(marked.value, "onenote:https://contoso.sharepoint.com/notebooks/work");
});

test("CLI path arguments are argv, not percent-encoded", () => {
  const winPath = "C:\\Users\\casua\\My Documents\\notes.txt";
  const result = fillActionTemplate(
    { params: [{ name: "path", required: true }], how: { type: "cli", template: "explorer.exe {path}" } },
    { path: winPath }
  );
  assert.equal(result.ok, true);
  assert.equal(result.exe, "explorer.exe");
  assert.deepEqual(result.args, [winPath]);
  assert.equal(result.args[0].includes("%20"), false);
});

test("calendar start/end stay compact local stamps and reuse the date parser", () => {
  const action = {
    params: [
      { name: "title", required: true },
      { name: "start", required: true },
      { name: "end", required: true },
    ],
    how: {
      type: "url",
      template: "https://calendar.google.com/calendar/r/eventedit?action=TEMPLATE&text={title}&dates={start}/{end}",
    },
  };
  const ready = fillActionTemplate(action, {
    title: "birthday party",
    start: "20261124T170000",
    end: "20261124T190000",
  });
  assert.equal(ready.ok, true);
  assert.match(ready.value, /dates=20261124T170000\/20261124T190000/);

  const parsed = fillActionTemplate(
    action,
    { title: "birthday party", start: "5pm", end: "7pm" },
    { utterance: 'add an event on 24-11-2026 - "birthday party" from 5-7pm', now: new Date("2026-11-23T08:00:00") }
  );
  assert.equal(parsed.ok, true);
  assert.match(parsed.value, /dates=20261124T170000\/20261124T190000/);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseIntentHeuristic,
} = require("../../src/helpers/overlay/commandMode/intentParser");
const {
  parseCalendarEvent,
} = require("../../src/helpers/overlay/commandMode/webApps");
const {
  createOrchestrator,
  sanitizePlan,
  attachFinishSteps,
  formatOutcome,
  isRawUtteranceSearch,
} = require("../../src/helpers/overlay/commandMode/orchestrator");

const NOW = new Date(2026, 10, 23, 12, 0, 0); // 23 Nov 2026

function urlsOf(steps) {
  return (steps || []).map((step) => step.args?.url).filter(Boolean);
}

function searchUrls(steps) {
  return urlsOf(steps).filter((url) => /google\.[^/]+\/search\?/i.test(url));
}

test("regression: can u open edge and search for youtube is a single Edge search", () => {
  const r = parseIntentHeuristic("can u open edge and search for youtube?");
  assert.equal(r.action, "open_url");
  assert.match(r.args.url, /google\.com\/search\?q=youtube/i);
  assert.equal(r.args.browser, "edge");
  assert.equal((r.steps || []).length, 0);
});

test("regression: open chrome and search weather in pune", () => {
  const r = parseIntentHeuristic("open chrome and search weather in pune");
  assert.equal(r.action, "open_url");
  assert.match(r.args.url, /q=weather(%20|\+)?in(%20|\+)?pune/i);
  assert.equal(r.args.browser, "chrome");
});

test("regression: can you open notepad?", () => {
  const r = parseIntentHeuristic("can you open notepad?");
  assert.equal(r.action, "open_app");
  assert.match(r.args.app, /notepad/i);
});

test("regression: open notepad and write a letter composes after open", () => {
  const r = parseIntentHeuristic("open notepad and write a letter");
  assert.equal(r.action, "plan");
  assert.equal(r.steps[0].action, "open_app");
  assert.equal(r.steps[0].args.app, "notepad");
  assert.equal(r.steps[1].action, "compose_text");
});

test("regression: add a meeting tomorrow 5pm gets a title and a one-hour span", () => {
  const r = parseCalendarEvent("open google calendar and add a meeting tomorrow 5pm", { now: NOW });
  assert.ok(r, "should parse a calendar event");
  const url = new URL(r.args.url);
  assert.equal(url.searchParams.get("text"), "Meeting");
  assert.equal(url.searchParams.get("dates"), "20261124T170000/20261124T180000");
});

test("birthday party 24 November 2026 from 5 p.m. to 7 prefills without a raw-utterance search", () => {
  const text =
    "calendar of cadu, can you add an event for 24 November 2026 for a birthday party from 5 p.m. to 7";
  const r = parseIntentHeuristic(text, { now: NOW });
  assert.equal(r.action, "open_url");
  const url = new URL(r.args.url);
  assert.match(url.hostname, /calendar\.google\.com/i);
  assert.equal(url.searchParams.get("text"), "birthday party");
  assert.equal(url.searchParams.get("dates"), "20261124T170000/20261124T190000");
  assert.equal(searchUrls(r.steps || [r]).length, 0);
});

test("sanitizePlan drops a Google search of the raw calendar utterance", () => {
  const text =
    "calendar of cadu, can you add an event for 24 November 2026 for a birthday party from 5 p.m. to 7";
  const calendar =
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=birthday%20party&dates=20261124T170000/20261124T190000";
  const search = "https://www.google.com/search?q=" + encodeURIComponent(text);
  const cleaned = sanitizePlan(text, [
    { action: "open_url", args: { url: calendar } },
    { action: "open_url", args: { url: search } },
  ]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].args.url, calendar);
  assert.equal(isRawUtteranceSearch(search, text), true);
});

test("autoSubmit appends a Ctrl+S finish step for calendar create, not for Gmail", () => {
  const text = "add an event on 24-11-2026 for a birthday party from 5-7pm";
  const calendar =
    "https://calendar.google.com/calendar/r/eventedit?action=TEMPLATE&text=birthday%20party&dates=20261124T170000/20261124T190000";
  const steps = attachFinishSteps(text, [{ action: "open_url", args: { url: calendar } }], {
    autoSaveCreatedItems: true,
  });
  assert.equal(steps[0].action, "open_url");
  assert.equal(steps[1].action, "submit_page");
  assert.equal(steps[1].args.keys, "control+s");
  assert.equal(steps[1].args.leaveUrl, "eventedit");

  const off = attachFinishSteps(text, [{ action: "open_url", args: { url: calendar } }], {
    autoSaveCreatedItems: false,
  });
  assert.equal(off.length, 1);

  const gmail = attachFinishSteps("compose an email to Riya about the party", [
    { action: "open_url", args: { url: "https://mail.google.com/mail/?view=cm&fs=1&to=Riya" } },
  ]);
  assert.equal(gmail.length, 1);
});

test("orchestrator does not dispatch the same intent twice and reports the real outcome", async () => {
  const text = 'open google calendar and add an event on 24-11-2026 - "birthday party" from 5-7pm';
  const intent = parseIntentHeuristic(text, { now: NOW });
  const calls = [];
  const windows = [];
  const keys = [];
  const orch = createOrchestrator({
    parseIntent: async () => intent,
    perform: async (request) => {
      calls.push(request);
      if (request.action === "open_url") {
        windows.splice(0, windows.length, {
          title: "Birthday party - Calendar - Google Chrome",
          url: request.args.url,
        });
      }
      return { success: true, message: "Opened" };
    },
    listWindows: async () => windows.slice(),
    focusWindow: async () => {},
    sendKeys: async (combo) => {
      keys.push(combo);
      windows.splice(0, windows.length, { title: "Google Calendar - Google Chrome", url: "https://calendar.google.com/calendar/r" });
    },
    sleep: async () => {},
    now: () => Date.now(),
  });

  const first = await orch.orchestrate(text, { autoSaveCreatedItems: true, autoRunTrusted: true });
  assert.equal(first.handled, true);
  assert.equal(first.success, true);
  assert.equal(first.deduped, undefined);
  assert.equal(calls.length, 1);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "control+s");
  assert.equal(searchUrls(first.steps).length, 0);
  assert.match(first.message, /Added Birthday party to your calendar for Nov 24, 5-7 PM/i);

  const second = await orch.orchestrate(text, { autoSaveCreatedItems: true });
  assert.equal(second.handled, true);
  assert.equal(second.deduped, true);
  assert.equal(calls.length, 1, "second call must not dispatch again");

  const notepadCalls = [];
  const notepadOrch = createOrchestrator({
    parseIntent: async (utterance) => parseIntentHeuristic(utterance),
    perform: async (request) => {
      notepadCalls.push(request);
      return { success: true, message: "Opened notepad" };
    },
    sleep: async () => {},
  });
  const parallel = await Promise.all([
    notepadOrch.orchestrate("can you open notepad?"),
    notepadOrch.orchestrate("can you open notepad?"),
  ]);
  assert.equal(notepadCalls.length, 1, "the same notepad intent must not dispatch twice");
  const deduped = parallel.filter((row) => row.deduped);
  assert.equal(deduped.length, 1);
  assert.ok(parallel.some((row) => row.handled && row.success && /Opened notepad/i.test(row.message)));
});

test("a lone search of the raw utterance is not added to a calendar plan", async () => {
  const text =
    "calendar of cadu, can you add an event for 24 November 2026 for a birthday party from 5 p.m. to 7";
  const calendar = parseIntentHeuristic(text, { now: NOW });
  const search = {
    action: "open_url",
    args: { url: "https://www.google.com/search?q=" + encodeURIComponent(text) },
  };
  const orch = createOrchestrator({
    parseIntent: async () => ({
      action: "plan",
      args: {},
      steps: [calendar, search],
      confidence: 0.9,
      source: "llm",
    }),
    perform: async (request) => ({ success: true, action: request.action, args: request.args }),
    sendKeys: async () => {},
    sleep: async () => {},
  });
  const result = await orch.orchestrate(text, { autoSaveCreatedItems: true });
  assert.equal(result.handled, true);
  assert.equal(searchUrls(result.steps).length, 0);
  assert.ok(result.steps.some((step) => step.action === "open_url"));
  assert.ok(result.steps.some((step) => step.action === "submit_page"));
  assert.match(result.message, /Added Birthday party/i);
});

test("formatOutcome for Edge youtube search", () => {
  const steps = [
    {
      action: "open_url",
      args: { url: "https://www.google.com/search?q=youtube", browser: "edge" },
    },
  ];
  const message = formatOutcome("can u open edge and search for youtube?", steps, [
    { success: true, action: "open_url" },
  ]);
  assert.match(message, /search for youtube/i);
  assert.match(message, /edge/i);
});

test("orchestrator stops mid-plan on AbortSignal without emitting stale progress or running remaining steps", async () => {
  const ac = new AbortController();
  const performed = [];
  const progressEvents = [];
  let parseCalled = 0;

  const orch = createOrchestrator({
    decideRoute: async () => ({ lane: "os_app", confidence: 0.9 }),
    parseIntent: async () => {
      parseCalled += 1;
      return {
        action: "plan",
        steps: [
          { action: "open_app", args: { app: "notepad" } },
          { action: "type_text", args: { text: "hello world" } },
        ],
        confidence: 0.95,
        source: "llm",
      };
    },
    perform: async (req, opts) => {
      performed.push({ action: req.action, hasSignal: Boolean(opts?.signal) });
      // Abort during the first step; step 2 must never start or emit progress.
      ac.abort();
      return { success: true, action: req.action, message: "Opened notepad" };
    },
  });

  const outcome = await orch.orchestrate("open notepad and type hello world", {
    signal: ac.signal,
    onProgress: (p) => progressEvents.push(p),
  });

  assert.equal(parseCalled, 1);
  assert.equal(performed.length, 1);
  assert.equal(performed[0].hasSignal, true);
  assert.equal(progressEvents.length, 1, "stale step 2 progress must not fire after abort");
  assert.equal(progressEvents[0].current, 1);
  assert.equal(outcome.handled, true);
  assert.equal(outcome.success, false);
  assert.equal(outcome.cancelled, true);
});

test("orchestrator skips parseIntent when AbortSignal aborts during decideRoute", async () => {
  const ac = new AbortController();
  let parseCalled = 0;

  const orch = createOrchestrator({
    decideRoute: async (_text, { signal }) => {
      assert.equal(signal, ac.signal);
      ac.abort();
      return { lane: "mcp_tool", confidence: 0.9 };
    },
    parseIntent: async () => {
      parseCalled += 1;
      return { action: "open_app", args: { app: "notepad" } };
    },
  });

  const outcome = await orch.orchestrate("check my tasks", { signal: ac.signal });
  assert.equal(parseCalled, 0, "parseIntent must not run after abort during route decision");
  assert.equal(outcome.handled, true);
  assert.equal(outcome.success, false);
  assert.equal(outcome.cancelled, true);
});

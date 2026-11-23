const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCalendarEvent,
  parseWebAppOpen,
  parseGmailCompose,
  parseEventDate,
  buildGmailComposeUrl,
} = require("../../src/helpers/overlay/commandMode/webApps");
const { parseIntentHeuristic } = require("../../src/helpers/overlay/commandMode/intentParser");
const { createCommandDispatcher } = require("../../src/helpers/overlay/commandMode/actionDispatcher");

const EXACT = 'open google calendar and add an event on 24-11-2026 - "birthday party" from 5-7pm';

function calendarDates(intent) {
  return new URL(intent.args.url).searchParams.get("dates");
}

test("Ridham's exact calendar utterance opens a local-time Google Calendar template", () => {
  const r = parseIntentHeuristic(EXACT);
  assert.equal(r.action, "open_url");
  assert.equal(r.source, "heuristic");
  const url = new URL(r.args.url);
  assert.equal(url.hostname, "calendar.google.com");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), "birthday party");
  assert.equal(url.searchParams.get("dates"), "20261124T170000/20261124T190000");
  assert.doesNotMatch(url.searchParams.get("dates"), /Z/);
});

test("from 5 to 7 pm and on 24 nov use the same local stamps", () => {
  const now = new Date(2026, 10, 23, 8, 0, 0);
  const a = parseCalendarEvent('add an event on 24-11-2026 called "birthday party" from 5 to 7 pm', { now });
  const b = parseCalendarEvent('add an event on 24 nov - "birthday party" from 5-7pm', { now });
  assert.equal(calendarDates(a), "20261124T170000/20261124T190000");
  assert.equal(calendarDates(b), "20261124T170000/20261124T190000");
});

test("tomorrow is the next local calendar day", () => {
  const now = new Date(2026, 10, 23, 22, 15, 0);
  const r = parseCalendarEvent('add an event tomorrow called "dentist" from 3 to 4 pm', { now });
  assert.equal(new URL(r.args.url).searchParams.get("text"), "dentist");
  assert.equal(calendarDates(r), "20261124T150000/20261124T160000");
  assert.deepEqual(parseEventDate("tomorrow", now), { year: 2026, month: 11, day: 24 });
});

for (const [utterance, host, browser] of [
  ["open google calendar", "calendar.google.com", undefined],
  ["open gmail", "mail.google.com", undefined],
  ["open youtube", "www.youtube.com", undefined],
  ["open google maps", "maps.google.com", undefined],
  ["open google drive", "drive.google.com", undefined],
  ["open google docs", "docs.google.com", undefined],
  ["open whatsapp web", "web.whatsapp.com", undefined],
  ["open google maps in edge", "maps.google.com", "edge"],
]) {
  test(`web app: ${utterance}`, () => {
    const r = parseIntentHeuristic(utterance);
    assert.equal(r.action, "open_url");
    assert.equal(new URL(r.args.url).hostname, host);
    if (browser) assert.equal(r.args.browser, browser);
  });
}

test("compose an email to X about Y is a Gmail compose action, not a refusal", () => {
  const r = parseIntentHeuristic("compose an email to Riya about the birthday party");
  assert.equal(r.action, "compose_email");
  assert.equal(r.args.to, "Riya");
  assert.equal(r.args.subject, "the birthday party");
  assert.match(r.args.prompt, /Riya/);
});

test("compose_email writes the body then opens a Gmail compose URL, and does not run the event", async () => {
  const calls = [];
  const dispatcher = createCommandDispatcher({
    platform: "linux",
    autoRunTrusted: true,
    getAutoRunTrusted: () => true,
    composeText: async (prompt) => {
      calls.push({ prompt });
      return "Hi Riya,\n\nLooking forward to the party.\n";
    },
    openExternal: async (url) => {
      calls.push({ url });
    },
    execFile: async () => {
      throw new Error("should not exec");
    },
  });
  const parsed = parseGmailCompose("compose an email to Riya about the birthday party");
  const result = await dispatcher.perform(parsed, { confirmed: true, autoRunTrusted: true });
  assert.equal(result.success, true);
  const opened = calls.find((c) => c.url);
  assert.ok(opened);
  const url = new URL(opened.url);
  assert.equal(url.hostname, "mail.google.com");
  assert.equal(url.searchParams.get("view"), "cm");
  assert.equal(url.searchParams.get("to"), "Riya");
  assert.equal(url.searchParams.get("su"), "the birthday party");
  assert.match(url.searchParams.get("body"), /Looking forward to the party/);
  const built = buildGmailComposeUrl({ to: "Riya", subject: "the birthday party", body: "Hi" });
  assert.match(built, /mail\.google\.com/);
  assert.equal(calls.some((c) => c.prompt), true);
});

test("named month dates, dotted meridians, for-titles, and a single 5pm default to one hour", () => {
  const now = new Date(2026, 10, 23);
  const party = parseCalendarEvent(
    "calendar of cadu, can you add an event for 24 November 2026 for a birthday party from 5 p.m. to 7",
    { now }
  );
  assert.ok(party);
  const url = new URL(party.args.url);
  assert.equal(url.searchParams.get("text"), "birthday party");
  assert.equal(url.searchParams.get("dates"), "20261124T170000/20261124T190000");

  const meeting = parseCalendarEvent("open google calendar and add a meeting tomorrow 5pm", { now });
  assert.ok(meeting);
  const meetingUrl = new URL(meeting.args.url);
  assert.equal(meetingUrl.searchParams.get("text"), "Meeting");
  assert.equal(meetingUrl.searchParams.get("dates"), "20261124T170000/20261124T180000");
});

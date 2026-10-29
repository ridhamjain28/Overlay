const test = require("node:test");
const assert = require("node:assert/strict");

const { mightContainIntent } = require("../../src/helpers/intents/intentDetector.js");
const { buildPrompt, validate, extractIntent } = require("../../src/helpers/intents/intentExtractor.js");
const { buildIcs } = require("../../src/helpers/intents/icsWriter.js");
const { ReminderScheduler } = require("../../src/helpers/intents/reminderScheduler.js");

// 1. Intent Trigger Detection (regex gate)
test("trigger detection: recognizes English meetings, reminders and to-dos", () => {
  assert.equal(mightContainIntent("meeting with John at 5pm"), true);
  assert.equal(mightContainIntent("remind me tomorrow to submit the quarterly report"), true);
  assert.equal(mightContainIntent("call Sarah at 3:30"), true);
  assert.equal(mightContainIntent("schedule a demo next Monday at 10am"), true);
  assert.equal(mightContainIntent("add to my to-do list: buy groceries tonight"), true);
  assert.equal(mightContainIntent("let's sync at 4"), true);
});

test("trigger detection: recognizes Hinglish phrases and time markers", () => {
  assert.equal(mightContainIntent("kal 5 baje meeting hai"), true);
  assert.equal(mightContainIntent("yaad dilana parso sham ko call karna hai"), true);
  assert.equal(mightContainIntent("aaj sham ko call karna"), true);
  assert.equal(mightContainIntent("subah 10 baje sync rakhte hain"), true);
});

test("false positive suppression: past tense and non-intents are rejected", () => {
  // Past tense mentions
  assert.equal(mightContainIntent("I had a meeting at 5 yesterday"), false);
  assert.equal(mightContainIntent("we met last Tuesday at 3"), false);
  assert.equal(mightContainIntent("I already sent the reminder last week"), false);

  // Casual conversation with no time or trigger
  assert.equal(mightContainIntent("the weather is really nice today"), false);
  assert.equal(mightContainIntent("hello how are you doing"), false);
  assert.equal(mightContainIntent("thanks for the update, see you soon"), false);
  assert.equal(mightContainIntent(""), false);
  assert.equal(mightContainIntent(null), false);
});

// 2. Extractor JSON Validator
test("extractor validation: accepts valid future event and computes default 30-min end", () => {
  const nowMs = new Date("2026-10-29T10:00:00.000Z").getTime();
  const raw = {
    type: "event",
    title: "Sprint Planning",
    start: "2026-10-29T14:00:00.000Z",
    end: null,
    confidence: 0.9,
  };

  const validated = validate(raw, nowMs);
  assert.ok(validated);
  assert.equal(validated.type, "event");
  assert.equal(validated.title, "Sprint Planning");
  assert.equal(validated.start, "2026-10-29T14:00:00.000Z");
  // End should default to start + 30 mins
  assert.equal(validated.end, "2026-10-29T14:30:00.000Z");
  assert.equal(validated.confidence, 0.9);
});

test("extractor validation: rejects low confidence and past events", () => {
  const nowMs = new Date("2026-10-29T10:00:00.000Z").getTime();

  // Confidence < 0.6
  const lowConf = {
    type: "event",
    title: "Maybe meet",
    start: "2026-10-29T14:00:00.000Z",
    confidence: 0.4,
  };
  assert.equal(validate(lowConf, nowMs), null);

  // Event in the past (> 5 minutes ago)
  const pastEvent = {
    type: "event",
    title: "Old Meeting",
    start: "2026-10-29T08:00:00.000Z",
    confidence: 0.95,
  };
  assert.equal(validate(pastEvent, nowMs), null);

  // Invalid date string
  const badDate = {
    type: "event",
    title: "Broken",
    start: "not-a-date",
    confidence: 0.85,
  };
  assert.equal(validate(badDate, nowMs), null);

  // Missing title
  const missingTitle = {
    type: "event",
    title: "   ",
    start: "2026-10-29T14:00:00.000Z",
    confidence: 0.85,
  };
  assert.equal(validate(missingTitle, nowMs), null);
});

test("extractor validation: permits to-dos without start time", () => {
  const nowMs = new Date("2026-10-29T10:00:00.000Z").getTime();
  const todo = {
    type: "todo",
    title: "Buy ergonomic keyboard",
    confidence: 0.88,
  };

  const validated = validate(todo, nowMs);
  assert.ok(validated);
  assert.equal(validated.type, "todo");
  assert.equal(validated.title, "Buy ergonomic keyboard");
  assert.equal(validated.start, null);
});

test("buildPrompt: formats prompt with text, now timestamp and timezone", () => {
  const prompt = buildPrompt("meeting tomorrow at 5", "2026-10-29T10:00:00.000Z", "Asia/Kolkata");
  assert.ok(prompt.includes("meeting tomorrow at 5"));
  assert.ok(prompt.includes("2026-10-29T10:00:00.000Z"));
  assert.ok(prompt.includes("Asia/Kolkata"));
});

// 3. Ollama extractIntent runner
test("extractIntent: parses valid response and handles markdown fencing", async () => {
  const mockResponse = {
    choices: [
      {
        message: {
          content: "```json\n{\"type\":\"event\",\"title\":\"Client Sync\",\"start\":\"2026-10-30T15:00:00.000Z\",\"confidence\":0.92}\n```",
        },
      },
    ],
  };

  const fakeFetch = async () => ({
    ok: true,
    json: async () => mockResponse,
  });

  const nowMs = new Date("2026-10-29T10:00:00.000Z").getTime();
  const result = await extractIntent({
    text: "meeting tomorrow at 3pm with client",
    fetchImpl: fakeFetch,
    nowMs,
  });

  assert.ok(result);
  assert.equal(result.type, "event");
  assert.equal(result.title, "Client Sync");
  assert.equal(result.start, "2026-10-30T15:00:00.000Z");
  assert.equal(result.end, "2026-10-30T15:30:00.000Z");
});

test("extractIntent: fails gracefully on network error or invalid JSON", async () => {
  const failingFetch = async () => {
    throw new Error("Connection refused");
  };

  const res1 = await extractIntent({
    text: "meeting tomorrow",
    fetchImpl: failingFetch,
  });
  assert.equal(res1, null);

  const badJsonFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "not valid json" } }] }),
  });

  const res2 = await extractIntent({
    text: "meeting tomorrow",
    fetchImpl: badJsonFetch,
  });
  assert.equal(res2, null);
});

// 4. RFC 5545 .ics Writer
test("icsWriter: generates compliant RFC 5545 calendar file with CRLF line endings", () => {
  const ics = buildIcs({
    title: "Product Review with Team",
    start: "2026-10-30T14:00:00.000Z",
    end: "2026-10-30T15:00:00.000Z",
    description: "Quarterly product roadmap review",
  });

  // Must use \r\n CRLF exclusively
  assert.ok(ics.includes("\r\n"), "Must contain CRLF");
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false, "Must not contain bare LF");

  // Core RFC 5545 structures
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.includes("VERSION:2.0\r\n"));
  assert.ok(ics.includes("PRODID:-//Overlay//Overlay//EN\r\n"));
  assert.ok(ics.includes("BEGIN:VEVENT\r\n"));
  assert.ok(ics.includes("SUMMARY:Product Review with Team\r\n"));
  assert.ok(ics.includes("DTSTART:20261030T140000Z\r\n"));
  assert.ok(ics.includes("DTEND:20261030T150000Z\r\n"));
  assert.ok(ics.includes("DESCRIPTION:Quarterly product roadmap review\r\n"));
  assert.ok(ics.includes("END:VEVENT\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});

test("icsWriter: folds lines exceeding 75 octets properly", () => {
  const longSummary = "A".repeat(120);
  const ics = buildIcs({
    title: longSummary,
    start: "2026-10-30T14:00:00.000Z",
  });

  // Folded continuation line starts with \r\n followed by a space
  assert.ok(ics.includes("\r\n "), "Must fold long lines with CRLF + space");
});

// Helper: In-memory mock database simulating better-sqlite3 API for node test runner
function createMockDb() {
  const rows = new Map();
  return {
    rows,
    exec(_sql) {},
    prepare(sql) {
      if (sql.includes("INSERT OR REPLACE")) {
        return {
          run(id, title, reminder_time, created_at) {
            rows.set(id, { id, title, reminder_time, created_at, fired: 0 });
          },
        };
      }
      if (sql.includes("SELECT * FROM dictation_reminders WHERE fired = 0")) {
        return {
          all() {
            return Array.from(rows.values())
              .filter((r) => r.fired === 0)
              .sort((a, b) => a.reminder_time.localeCompare(b.reminder_time));
          },
        };
      }
      if (sql.includes("UPDATE dictation_reminders SET fired = 1")) {
        return {
          run(id) {
            const r = rows.get(id);
            if (r) r.fired = 1;
          },
        };
      }
      if (sql.includes("DELETE FROM dictation_reminders")) {
        return {
          run(id) {
            rows.delete(id);
          },
        };
      }
      if (sql.includes("SELECT * FROM dictation_reminders WHERE id = ?")) {
        return {
          get(id) {
            return rows.get(id) || null;
          },
        };
      }
      return { run() {}, all() { return []; }, get() { return null; } };
    },
    close() {},
  };
}

// 5. SQLite Reminder Scheduler
test("reminderScheduler: schedules in SQLite and triggers notifications", (t, done) => {
  const db = createMockDb();
  let notifiedTitle = null;

  class FakeNotification {
    static isSupported() {
      return true;
    }
    constructor(opts) {
      notifiedTitle = opts.body;
    }
    show() {}
  }

  const scheduler = new ReminderScheduler(db, { NotificationImpl: FakeNotification });

  // Schedule a reminder due in 20ms
  const targetTime = new Date(Date.now() + 20).toISOString();
  const scheduled = scheduler.schedule({
    title: "Drink Water",
    time: targetTime,
  });

  assert.ok(scheduled.id);
  assert.equal(scheduled.title, "Drink Water");

  // Verify stored in mock SQLite
  const row = db.prepare("SELECT * FROM dictation_reminders WHERE id = ?").get(scheduled.id);
  assert.ok(row);
  assert.equal(row.title, "Drink Water");
  assert.equal(row.fired, 0);

  // Wait for timer to fire
  setTimeout(() => {
    try {
      assert.equal(notifiedTitle, "Drink Water");
      const updatedRow = db.prepare("SELECT * FROM dictation_reminders WHERE id = ?").get(scheduled.id);
      assert.equal(updatedRow.fired, 1);
      scheduler.clearAll();
      done();
    } catch (err) {
      scheduler.clearAll();
      done(err);
    }
  }, 50);
});

test("reminderScheduler: restores pending reminders on startup", () => {
  const db = createMockDb();
  const scheduler1 = new ReminderScheduler(db);

  const futureTime = new Date(Date.now() + 60000).toISOString();
  scheduler1.schedule({ title: "Future Task", time: futureTime });
  scheduler1.clearAll(); // Simulate app shutdown

  // Simulate new startup
  const scheduler2 = new ReminderScheduler(db);
  const restored = scheduler2.restorePendingReminders();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].title, "Future Task");
  assert.equal(scheduler2.timers.size, 1);

  scheduler2.clearAll();
});

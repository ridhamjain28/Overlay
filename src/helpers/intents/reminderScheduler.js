// Overlay: SQLite-backed local reminder scheduler.
// Persists reminders in SQLite and restores them on app startup.
// When a reminder's time arrives, displays a local system notification.

"use strict";

const { Notification } = require("electron");

class ReminderScheduler {
  constructor(database, options = {}) {
    this.db = database;
    this.timers = new Map();
    this.Notification = options.NotificationImpl || (typeof Notification === "function" ? Notification : null);
    this._initTable();
  }

  _initTable() {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS dictation_reminders (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          reminder_time TEXT NOT NULL,
          created_at TEXT NOT NULL,
          fired INTEGER DEFAULT 0
        )
      `);
    } catch {
      // Table creation failure is non-fatal
    }
  }

  restorePendingReminders() {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(
        "SELECT * FROM dictation_reminders WHERE fired = 0 ORDER BY reminder_time ASC"
      );
      const rows = stmt.all();
      const now = Date.now();
      for (const row of rows) {
        const timeMs = new Date(row.reminder_time).getTime();
        if (timeMs <= now) {
          // Overdue while closed: fire immediately or mark fired if older than 1 hour
          if (now - timeMs < 60 * 60 * 1000) {
            this.fire(row);
          } else {
            this.markFired(row.id);
          }
        } else {
          this.setTimer(row.id, row.title, timeMs);
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  schedule({ id, title, time }) {
    const reminderId = id || `rem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const isoTime = new Date(time).toISOString();
    const nowIso = new Date().toISOString();

    if (this.db) {
      try {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO dictation_reminders (id, title, reminder_time, created_at, fired) VALUES (?, ?, ?, ?, 0)"
        );
        stmt.run(reminderId, title, isoTime, nowIso);
      } catch {}
    }

    const timeMs = new Date(time).getTime();
    this.setTimer(reminderId, title, timeMs);

    return { id: reminderId, title, time: isoTime };
  }

  setTimer(id, title, timeMs) {
    if (this.timers.has(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }

    const delay = Math.max(0, timeMs - Date.now());
    // Max delay supported by setTimeout is ~24.8 days (2^31 - 1 ms)
    const safeDelay = Math.min(delay, 2147483647);

    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.fire({ id, title, reminder_time: new Date(timeMs).toISOString() });
    }, safeDelay);

    this.timers.set(id, timer);
  }

  fire(reminder) {
    this.markFired(reminder.id);
    const Notif = this.Notification;
    if (Notif && Notif.isSupported && Notif.isSupported()) {
      try {
        const notif = new Notif({
          title: "Overlay Reminder",
          body: reminder.title,
          silent: false,
        });
        notif.show();
      } catch {}
    }
  }

  markFired(id) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare("UPDATE dictation_reminders SET fired = 1 WHERE id = ?");
      stmt.run(id);
    } catch {}
  }

  cancel(id) {
    if (this.timers.has(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
    if (this.db) {
      try {
        const stmt = this.db.prepare("DELETE FROM dictation_reminders WHERE id = ?");
        stmt.run(id);
      } catch {}
    }
  }

  clearAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

module.exports = { ReminderScheduler };

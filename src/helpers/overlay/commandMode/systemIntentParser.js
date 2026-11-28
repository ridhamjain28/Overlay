// Sub-1ms heuristic parser for instant OS controls, time queries, timers, and reminders.
// Pure functions — no Electron, no network.

/**
 * Parse a duration phrase like "5 minutes", "30 sec", "1 hour" into milliseconds.
 * @param {string} amountStr
 * @param {string} unitStr
 * @returns {number | null}
 */
function parseDurationMs(amountStr, unitStr) {
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const u = String(unitStr || "").toLowerCase();
  if (u.startsWith("h")) return Math.round(amount * 3600 * 1000);
  if (u.startsWith("m")) return Math.round(amount * 60 * 1000);
  return Math.round(amount * 1000);
}

/**
 * Parse instant system commands, media controls, time queries, timers, and reminders.
 * Returns null if the utterance is not a recognized system command.
 * @param {string} text
 * @returns {{ action: string, args: Record<string, unknown>, confidence: number } | null}
 */
function parseSystemCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[.!?]+$/, "").trim();

  // Lock screen (always confirm-gated in actionDispatcher)
  if (/^(lock|lock screen|lock computer|lock my computer|lock the screen)$/.test(lower)) {
    return { action: "lock_screen", args: {}, confidence: 0.98 };
  }

  // Show time
  if (
    /^(what time is it|what's the time|whats the time|time|current time|tell me the time|kitne baje hain|baj gaye)$/.test(
      lower
    )
  ) {
    return { action: "show_time", args: {}, confidence: 0.98 };
  }

  // Screenshot
  if (/^(screenshot|take screenshot|take a screenshot|capture screen|screen capture|screengrab)$/.test(lower)) {
    return { action: "screenshot", args: {}, confidence: 0.98 };
  }

  // Volume set: "set volume to 50%", "volume 40"
  const volSet = lower.match(/^(?:set\s+)?volume\s+(?:to\s+)?(\d{1,3})\s*%?$/);
  if (volSet) {
    const level = Math.min(100, Math.max(0, Number(volSet[1])));
    return { action: "volume_set", args: { level }, confidence: 0.97 };
  }

  // Volume up / down / mute
  if (/^(volume up|turn up volume|turn up the volume|increase volume|louder|zyada awaaz)$/.test(lower)) {
    return { action: "volume_up", args: {}, confidence: 0.97 };
  }
  if (/^(volume down|turn down volume|turn down the volume|decrease volume|quieter|less volume|kam awaaz)$/.test(lower)) {
    return { action: "volume_down", args: {}, confidence: 0.97 };
  }
  if (/^(mute|silence|mute volume|mute audio|awaaz band)$/.test(lower)) {
    return { action: "volume_mute", args: {}, confidence: 0.97 };
  }

  // Media controls
  if (/^(play|pause|play\/pause|toggle music|play music|pause music|resume music)$/.test(lower)) {
    return { action: "media_play_pause", args: {}, confidence: 0.96 };
  }
  if (/^(next|next song|next track|skip|skip song|skip track)$/.test(lower)) {
    return { action: "media_next", args: {}, confidence: 0.96 };
  }
  if (/^(previous|prev song|previous song|previous track|prev track)$/.test(lower)) {
    return { action: "media_previous", args: {}, confidence: 0.96 };
  }

  // Brightness
  const brightSet = lower.match(/^(?:set\s+)?brightness\s+(?:to\s+)?(\d{1,3})\s*%?$/);
  if (brightSet) {
    const level = Math.min(100, Math.max(0, Number(brightSet[1])));
    return { action: "brightness_set", args: { level }, confidence: 0.96 };
  }
  if (/^(brightness up|increase brightness|brighter)$/.test(lower)) {
    return { action: "brightness_set", args: { delta: "up" }, confidence: 0.96 };
  }
  if (/^(brightness down|decrease brightness|dimmer)$/.test(lower)) {
    return { action: "brightness_set", args: { delta: "down" }, confidence: 0.96 };
  }

  // Reminder: "remind me in 10 min to call mom"
  const remMatch = lower.match(
    /^(?:remind me|set a reminder)\s+in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+(?:to\s+)?(.+)$/
  );
  if (remMatch) {
    const durationMs = parseDurationMs(remMatch[1], remMatch[2]);
    if (durationMs) {
      return {
        action: "reminder",
        args: { durationMs, message: remMatch[3].trim() },
        confidence: 0.97,
      };
    }
  }

  // Timer: "set a timer for 5 minutes", "5 minute timer", "timer 30 sec"
  const timerA = lower.match(
    /^(?:set\s+(?:a\s+)?)?timer\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?:\s+(?:for|called)\s+(.+))?$/
  );
  if (timerA) {
    const durationMs = parseDurationMs(timerA[1], timerA[2]);
    if (durationMs) {
      return {
        action: "timer",
        args: { durationMs, ...(timerA[3] ? { label: timerA[3].trim() } : {}) },
        confidence: 0.97,
      };
    }
  }
  const timerB = lower.match(
    /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+timer$/
  );
  if (timerB) {
    const durationMs = parseDurationMs(timerB[1], timerB[2]);
    if (durationMs) {
      return { action: "timer", args: { durationMs }, confidence: 0.97 };
    }
  }

  return null;
}

module.exports = {
  parseSystemCommand,
  parseDurationMs,
};

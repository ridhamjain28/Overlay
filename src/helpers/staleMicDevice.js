// Detects the OverconstrainedError getUserMedia throws when a saved deviceId no
// longer matches any device. Chromium rotates mediaDevices IDs over time, so a
// pinned { deviceId: { exact } } eventually goes stale and recording fails. See #900.
export function isStaleDeviceError(error) {
  if (!error || error.name !== "OverconstrainedError") return false;
  // deviceId is the only constraint pinned with { exact }; treat an unknown/empty
  // constraint as the device too, but skip a known non-deviceId constraint.
  const constraint = error.constraint;
  return !constraint || constraint === "deviceId";
}

/**
 * Detects errors indicating an audio device was unplugged, battery died,
 * Bluetooth dropped, or became unavailable.
 */
export function isDeviceDisconnectedError(error) {
  if (!error) return false;
  if (isStaleDeviceError(error)) return true;
  const name = error.name || "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return true;
  const msg = String(error.message || "").toLowerCase();
  if (
    name === "NotReadableError" &&
    (msg.includes("device") ||
      msg.includes("audio") ||
      msg.includes("hardware") ||
      msg.includes("could not start") ||
      msg.includes("failed"))
  ) {
    return true;
  }
  if (
    msg.includes("device not found") ||
    msg.includes("disconnected") ||
    msg.includes("unplugged") ||
    msg.includes("no such device")
  ) {
    return true;
  }
  return false;
}


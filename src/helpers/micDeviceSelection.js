const BUILT_IN_MIC_REGEX = /built[ -]?in|internal|integrated|macbook|realtek/i;

/**
 * Finds the best default or built-in fallback microphone among available inputs.
 */
export function findFallbackMicrophone(devices = []) {
  const audioInputs = devices.filter(
    (device) => device.kind === undefined || device.kind === "audioinput"
  );
  if (audioInputs.length === 0) return null;
  // 1. Look for deviceId === "default"
  const defaultDevice = audioInputs.find((d) => d.deviceId === "default");
  if (defaultDevice) return defaultDevice;
  // 2. Look for built-in microphone
  const builtIn = audioInputs.find((d) => BUILT_IN_MIC_REGEX.test(d.label || ""));
  if (builtIn) return builtIn;
  // 3. Fallback to first available input
  return audioInputs[0] || null;
}

/**
 * Reconcile a saved microphone preference with the devices Chromium currently
 * exposes. deviceId is preferred while it remains valid; the label is only a
 * recovery key when exactly one current input has that label.
 */
export function resolveMicDeviceSelection(
  devices,
  selectedDeviceId,
  selectedDeviceLabel,
  { fallbackToDefault = false } = {}
) {
  if (!selectedDeviceId) {
    return { device: null, status: "default" };
  }

  // Callers pass raw MediaDeviceInfo lists or pre-filtered inputs without a kind.
  const audioInputs = devices.filter(
    (device) => device.kind === undefined || device.kind === "audioinput"
  );
  const exactMatch = audioInputs.find((device) => device.deviceId === selectedDeviceId);

  if (exactMatch) {
    return { device: exactMatch, status: "exact" };
  }

  if (!selectedDeviceLabel) {
    if (fallbackToDefault) {
      const fallback = findFallbackMicrophone(audioInputs);
      if (fallback) {
        return {
          device: fallback,
          status: "fallback",
          previousDeviceId: selectedDeviceId,
          previousLabel: selectedDeviceLabel,
        };
      }
    }
    return { device: null, status: "missing" };
  }

  const labelMatches = audioInputs.filter(
    (device) => device.deviceId !== "default" && device.label === selectedDeviceLabel
  );

  if (labelMatches.length === 1) {
    return { device: labelMatches[0], status: "remapped" };
  }

  if (fallbackToDefault) {
    const fallback = findFallbackMicrophone(audioInputs);
    if (fallback) {
      return {
        device: fallback,
        status: "fallback",
        previousDeviceId: selectedDeviceId,
        previousLabel: selectedDeviceLabel,
      };
    }
  }

  return {
    device: null,
    status: labelMatches.length > 1 ? "ambiguous" : "missing",
  };
}

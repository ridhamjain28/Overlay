const test = require("node:test");
const assert = require("node:assert/strict");

class FakeTrack extends EventTarget {
  constructor({
    deviceId = "mic-headset",
    groupId = "group-headset",
    label = "AirPods Pro",
    muted = false,
    readyState = "live",
  } = {}) {
    super();
    this.readyState = readyState;
    this.muted = muted;
    this.label = label;
    this.settings = { deviceId, groupId };
    this.stopped = false;
  }

  getSettings() {
    return this.settings;
  }

  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(track) {
    this.track = track;
    this.stopped = false;
  }

  getAudioTracks() {
    return this.track ? [this.track] : [];
  }

  getTracks() {
    return this.track ? [this.track] : [];
  }

  stop() {
    this.stopped = true;
    this.track?.stop();
  }
}

class FakeMediaDevices extends EventTarget {
  constructor(devices = []) {
    super();
    this.devices = devices;
  }

  async enumerateDevices() {
    return this.devices;
  }

  change(devices) {
    this.devices = devices;
    this.dispatchEvent(new Event("devicechange"));
  }
}

const mic = (deviceId, label = deviceId, groupId = deviceId) => ({
  kind: "audioinput",
  deviceId,
  groupId,
  label,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("watchdog and listener detect devicechange and system default mic changes", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const mediaDevices = new FakeMediaDevices([
    mic("default", "Default - AirPods Pro", "g-1"),
    mic("mic-airpods", "AirPods Pro", "g-1"),
    mic("mic-builtin", "Built-in Microphone", "g-2"),
  ]);

  const initialStream = new FakeStream(
    new FakeTrack({ deviceId: "mic-airpods", label: "AirPods Pro" })
  );
  let recoveredStream = null;
  let currentSystemDefault = { name: "AirPods Pro", nativeId: "airpods-id" };

  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    getSystemDefault: async () => currentSystemDefault,
    acquire: async () =>
      new FakeStream(
        new FakeTrack({ deviceId: "mic-builtin", label: "Built-in Microphone" })
      ),
    onRecovered: async (replacement) => {
      recoveredStream = replacement;
    },
    debounceMs: 5,
    watchdogIntervalMs: 20,
  });

  await controller.start(initialStream, { followDefault: true });

  // System default changes (e.g. OS switches default from AirPods to Built-in)
  currentSystemDefault = { name: "Built-in Microphone", nativeId: "builtin-id" };
  mediaDevices.change([
    mic("default", "Default - Built-in Microphone", "g-2"),
    mic("mic-builtin", "Built-in Microphone", "g-2"),
  ]);

  await delay(50);
  assert.ok(recoveredStream, "Controller should recover when system default mic changes");
  assert.equal(recoveredStream.getAudioTracks()[0].label, "Built-in Microphone");

  controller.stop();
});

test("when active mic device disappears (Bluetooth dies / unplugged), cleanly falls back to default mic", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");

  const mediaDevices = new FakeMediaDevices([
    mic("mic-headset", "Wireless Headset", "g-headset"),
    mic("default", "Built-in Laptop Microphone", "g-builtin"),
    mic("mic-builtin", "Built-in Laptop Microphone", "g-builtin"),
  ]);

  const headsetStream = new FakeStream(
    new FakeTrack({ deviceId: "mic-headset", label: "Wireless Headset" })
  );
  const defaultStream = new FakeStream(
    new FakeTrack({ deviceId: "default", label: "Built-in Laptop Microphone" })
  );

  let fallbackEvents = [];
  let recoveredStream = null;

  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async (reason) => {
      // Simulate headset completely gone from OS: acquire preferred throws
      if (reason !== "fallback") {
        const err = new Error("Requested device not found");
        err.name = "NotFoundError";
        throw err;
      }
      return defaultStream;
    },
    acquireFallback: async () => defaultStream,
    onRecovered: async (replacement) => {
      recoveredStream = replacement;
    },
    onFallback: (data) => {
      fallbackEvents.push(data);
    },
    debounceMs: 5,
    watchdogIntervalMs: 20,
  });

  await controller.start(headsetStream, { followDefault: true });

  // Headset disconnected / battery dead: device drops out of mediaDevices list
  mediaDevices.change([
    mic("default", "Built-in Laptop Microphone", "g-builtin"),
    mic("mic-builtin", "Built-in Laptop Microphone", "g-builtin"),
  ]);

  await delay(60);

  assert.ok(recoveredStream, "Should have cleanly recovered stream without throwing");
  assert.equal(
    recoveredStream.getAudioTracks()[0].label,
    "Built-in Laptop Microphone"
  );
  assert.equal(controller.status, "active", "Session must remain active");
  assert.ok(fallbackEvents.length > 0, "Should emit fallback notification event");
  assert.equal(fallbackEvents[0].previousDevice, "Wireless Headset");
  assert.equal(fallbackEvents[0].fallbackDevice, "Built-in Laptop Microphone");

  controller.stop();
});

test("when active track stays muted/unhealthy for >1.5s, triggers fallback to default mic", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");

  const mediaDevices = new FakeMediaDevices([
    mic("mic-1", "USB Studio Mic"),
    mic("default", "Built-in Microphone"),
  ]);

  const track = new FakeTrack({ deviceId: "mic-1", label: "USB Studio Mic", muted: false });
  const originalStream = new FakeStream(track);
  const fallbackStream = new FakeStream(
    new FakeTrack({ deviceId: "default", label: "Built-in Microphone" })
  );

  let fallbackEvent = null;
  let recoveredStream = null;

  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => fallbackStream,
    onRecovered: async (replacement) => {
      recoveredStream = replacement;
    },
    onFallback: (event) => {
      fallbackEvent = event;
    },
    muteGraceMs: 30, // Test with compressed mute grace timeout (<1.5s in test)
    watchdogIntervalMs: 15,
  });

  await controller.start(originalStream);

  // Mic hardware freezes or goes mute
  track.muted = true;
  track.dispatchEvent(new Event("mute"));

  // Before mute grace elapses, should NOT have recovered yet
  await delay(10);
  assert.equal(recoveredStream, null, "Should not recover before mute grace threshold");

  // After mute grace (> 30ms in test, corresponding to > 1.5s in production)
  await delay(45);
  assert.ok(recoveredStream, "Must fallback after track is muted longer than grace period");
  assert.equal(recoveredStream.getAudioTracks()[0].label, "Built-in Microphone");
  assert.ok(fallbackEvent, "Fallback event must be emitted");
  assert.equal(fallbackEvent.reason, "muted");

  controller.stop();
});

test("transient mute (<1.5s) that unmutes does not trigger fallback", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");

  const mediaDevices = new FakeMediaDevices([mic("mic-1", "AirPods Pro")]);
  const track = new FakeTrack({ deviceId: "mic-1", label: "AirPods Pro", muted: false });
  const stream = new FakeStream(track);

  let recoveredCount = 0;

  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => new FakeStream(new FakeTrack({ deviceId: "mic-2" })),
    onRecovered: async () => {
      recoveredCount += 1;
    },
    muteGraceMs: 60,
    watchdogIntervalMs: 20,
  });

  await controller.start(stream);

  // Transient mute
  track.muted = true;
  track.dispatchEvent(new Event("mute"));
  await delay(20);

  // Quickly unmute before grace period expires
  track.muted = false;
  track.dispatchEvent(new Event("unmute"));
  await delay(70);

  assert.equal(recoveredCount, 0, "Transient mute must not trigger recovery");
  controller.stop();
});

test("watchdog detects resume from sleep (clock jump) and re-evaluates mic health", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");

  const mediaDevices = new FakeMediaDevices([
    mic("mic-headset", "Bluetooth Headset"),
    mic("default", "Built-in Microphone"),
  ]);

  const track = new FakeTrack({ deviceId: "mic-headset", label: "Bluetooth Headset" });
  const original = new FakeStream(track);
  const fallback = new FakeStream(new FakeTrack({ deviceId: "default", label: "Built-in Microphone" }));

  let recovered = null;

  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => fallback,
    onRecovered: async (rep) => {
      recovered = rep;
    },
    watchdogIntervalMs: 1000,
  });

  await controller.start(original);

  // Simulate machine sleep: last watchdog tick was 10 seconds ago
  controller.lastWatchdogTick = Date.now() - 10000;
  // During sleep, headset was disconnected and track died
  track.readyState = "ended";

  // Watchdog fires after wake
  await controller.tickWatchdog();

  assert.ok(recovered, "Must recover immediately upon detecting sleep resume");
  assert.equal(recovered, fallback);

  controller.stop();
});

test("provides IPC/renderer event audio-device-fallback with accurate details", async () => {
  const { emitAudioDeviceFallback } = await import("../../src/helpers/activeMicRecovery.js");

  let dispatchedEvent = null;
  let electronApiNotified = null;

  // Mock window & electronAPI
  const originalWindow = globalThis.window;
  globalThis.window = {
    electronAPI: {
      notifyAudioDeviceFallback: (data) => {
        electronApiNotified = data;
      },
    },
    dispatchEvent: (event) => {
      dispatchedEvent = event;
    },
  };

  try {
    const payload = emitAudioDeviceFallback({
      previousDevice: "AirPods Max",
      fallbackDevice: "MacBook Pro Microphone",
      reason: "device-missing",
    });

    assert.equal(payload.previousDevice, "AirPods Max");
    assert.equal(payload.fallbackDevice, "MacBook Pro Microphone");
    assert.equal(payload.reason, "device-missing");
    assert.equal(electronApiNotified?.previousDevice, "AirPods Max");
    assert.equal(dispatchedEvent?.type, "audio-device-fallback");
    assert.equal(dispatchedEvent?.detail?.previousDevice, "AirPods Max");
  } finally {
    globalThis.window = originalWindow;
  }
});

test("resolveMicDeviceSelection cleanly resolves fallback microphone when device is disconnected", async () => {
  const { resolveMicDeviceSelection, findFallbackMicrophone } = await import(
    "../../src/helpers/micDeviceSelection.js"
  );

  const availableDevices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Internal Microphone" },
    { kind: "audioinput", deviceId: "built-in-1", label: "Realtek High Definition Audio" },
  ];

  // Preferred device "usb-mic" is missing
  const withoutFallback = resolveMicDeviceSelection(
    availableDevices,
    "usb-mic",
    "Yeti Stereo Microphone"
  );
  assert.deepEqual(withoutFallback, { device: null, status: "missing" });

  const withFallback = resolveMicDeviceSelection(
    availableDevices,
    "usb-mic",
    "Yeti Stereo Microphone",
    { fallbackToDefault: true }
  );
  assert.equal(withFallback.status, "fallback");
  assert.equal(withFallback.device.deviceId, "default");

  const fallbackDirect = findFallbackMicrophone(availableDevices);
  assert.equal(fallbackDirect.deviceId, "default");
});

test("isDeviceDisconnectedError detects disconnected, unplugged, and missing devices", async () => {
  const { isDeviceDisconnectedError, isStaleDeviceError } = await import(
    "../../src/helpers/staleMicDevice.js"
  );

  // OverconstrainedError
  assert.equal(isDeviceDisconnectedError({ name: "OverconstrainedError", constraint: "deviceId" }), true);
  assert.equal(isStaleDeviceError({ name: "OverconstrainedError", constraint: "deviceId" }), true);

  // NotFoundError (Bluetooth disconnected / USB unplugged)
  assert.equal(isDeviceDisconnectedError({ name: "NotFoundError" }), true);
  // Preserves existing isStaleDeviceError contract:
  assert.equal(isStaleDeviceError({ name: "NotFoundError" }), false);

  // DevicesNotFoundError
  assert.equal(isDeviceDisconnectedError({ name: "DevicesNotFoundError" }), true);

  // NotReadableError with device message
  assert.equal(
    isDeviceDisconnectedError({ name: "NotReadableError", message: "Could not start audio source" }),
    true
  );

  // Generic disconnect message
  assert.equal(isDeviceDisconnectedError(new Error("Audio device disconnected")), true);

  // Unrelated errors return false
  assert.equal(isDeviceDisconnectedError({ name: "NotAllowedError" }), false);
  assert.equal(isDeviceDisconnectedError(null), false);
});

test("stop cleanly shuts down watchdog timer, listeners, and mute timer", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");

  const mediaDevices = new FakeMediaDevices([mic("mic-1")]);
  const track = new FakeTrack({ deviceId: "mic-1" });
  const stream = new FakeStream(track);

  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => stream,
    onRecovered: async () => {},
    watchdogIntervalMs: 50,
  });

  await controller.start(stream);
  assert.ok(controller.watchdogTimer, "Watchdog should be running");

  controller.stop();
  assert.equal(controller.started, false);
  assert.equal(controller.watchdogTimer, null, "Watchdog timer must be cleared");
  assert.equal(controller.muteTimer, null, "Mute timer must be cleared");
  assert.equal(controller.status, "inactive");
});

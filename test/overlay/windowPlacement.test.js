const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const {
  SAFE_PADDING,
  clampWindowToDisplayWorkArea,
  convertDpiCoordinates,
  clampedBounds,
  centeredBounds,
} = require("../../src/helpers/onboardingWindowBounds");

const MainWindowPlacementCoordinator = require("../../src/helpers/mainWindowPlacementCoordinator");
const { WindowPositionUtil } = require("../../src/helpers/windowConfig");

// ---------------------------------------------------------
// Test Fixtures for Displays
// ---------------------------------------------------------

// 1. Standard 1080p with bottom taskbar (height 40px)
const DISPLAY_1080P_BOTTOM_TASKBAR = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1.0,
};

// 2. 1080p with left taskbar (width 80px, e.g. Ubuntu / vertical Windows taskbar)
const DISPLAY_1080P_LEFT_TASKBAR = {
  id: 2,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 80, y: 0, width: 1840, height: 1080 },
  scaleFactor: 1.0,
};

// 3. 1080p with top menu/taskbar (height 30px, e.g. macOS menu bar)
const DISPLAY_1080P_TOP_TASKBAR = {
  id: 3,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 30, width: 1920, height: 1050 },
  scaleFactor: 1.0,
};

// 4. 1080p with right taskbar (width 80px)
const DISPLAY_1080P_RIGHT_TASKBAR = {
  id: 4,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1840, height: 1080 },
  scaleFactor: 1.0,
};

// 5. Mixed DPI Setup:
// Primary 4K with 150% scale factor (DIP: 2560x1440, taskbar 48px at bottom)
const DISPLAY_4K_150_PRIMARY = {
  id: 10,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  scaleFactor: 1.5,
};

// Secondary 1080p with 100% scale factor to the right of primary (x: 2560)
const DISPLAY_1080P_100_SECONDARY_RIGHT = {
  id: 20,
  bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1.0,
};

// Secondary 1080p with 100% scale factor to the left of primary (negative origin)
const DISPLAY_1080P_100_SECONDARY_LEFT = {
  id: 21,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1.0,
};

// Secondary monitor mounted above primary (negative y origin)
const DISPLAY_MONITOR_ABOVE = {
  id: 22,
  bounds: { x: 0, y: -1080, width: 1920, height: 1080 },
  workArea: { x: 0, y: -1080, width: 1920, height: 1040 },
  scaleFactor: 1.0,
};

// Helper to create mock BrowserWindow
function createMockBrowserWindow(initialBounds) {
  let bounds = { ...initialBounds };
  let destroyed = false;
  const setBoundsCalls = [];

  return {
    getBounds: () => ({ ...bounds }),
    setBounds: (next) => {
      bounds = { ...next };
      setBoundsCalls.push({ ...next });
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      send: () => {},
      on: () => {},
    },
    get setBoundsCalls() {
      return setBoundsCalls;
    },
  };
}

// =========================================================
// Group 1: clampWindowToDisplayWorkArea tests
// =========================================================

test("SAFE_PADDING is 12px by default", () => {
  assert.equal(SAFE_PADDING, 12);
});

test("clampWindowToDisplayWorkArea: leaves window already fully inside work area untouched", () => {
  const windowBounds = { x: 500, y: 400, width: 300, height: 200 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_BOTTOM_TASKBAR);

  assert.deepEqual(clamped, { x: 500, y: 400, width: 300, height: 200 });
});

test("clampWindowToDisplayWorkArea: clamps bottom taskbar with 12px safe margin", () => {
  // Window sticking into bottom taskbar (workArea height is 1040)
  const windowBounds = { x: 100, y: 950, width: 200, height: 100 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_BOTTOM_TASKBAR);

  // y + height must be <= 1040 - 12 = 1028 -> y <= 928
  assert.equal(clamped.y, 928);
  assert.equal(clamped.y + clamped.height, 1040 - 12);
  assert.equal(clamped.x, 100);
});

test("clampWindowToDisplayWorkArea: clamps left taskbar with 12px safe margin", () => {
  // Window placed at x: 20 on a display with an 80px left taskbar (workArea.x = 80)
  const windowBounds = { x: 20, y: 200, width: 200, height: 100 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_LEFT_TASKBAR);

  // x must be >= 80 + 12 = 92
  assert.equal(clamped.x, 92);
  assert.equal(clamped.y, 200);
});

test("clampWindowToDisplayWorkArea: clamps top menu/taskbar with 12px safe margin", () => {
  // Window placed at y: 10 on display with a 30px top bar (workArea.y = 30)
  const windowBounds = { x: 300, y: 10, width: 200, height: 100 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_TOP_TASKBAR);

  // y must be >= 30 + 12 = 42
  assert.equal(clamped.y, 42);
  assert.equal(clamped.x, 300);
});

test("clampWindowToDisplayWorkArea: clamps right taskbar with 12px safe margin", () => {
  // Window at x: 1750 on display with right taskbar (workArea.width = 1840)
  const windowBounds = { x: 1750, y: 200, width: 200, height: 100 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_RIGHT_TASKBAR);

  // x + width <= 1840 - 12 = 1828 -> x <= 1628
  assert.equal(clamped.x, 1628);
  assert.equal(clamped.x + clamped.width, 1840 - 12);
});

test("clampWindowToDisplayWorkArea: clamps on negative-origin left display", () => {
  // Secondary monitor on left: workArea.x = -1920, width = 1920 (right edge at 0)
  // Window off to the far left at x: -2200
  const windowBounds = { x: -2200, y: 300, width: 200, height: 100 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_100_SECONDARY_LEFT);

  // x must be >= -1920 + 12 = -1908
  assert.equal(clamped.x, -1908);
  assert.equal(clamped.y, 300);

  // Window off to the right edge of this monitor (x: -50, width: 200 -> ends at 150)
  const windowNearRight = { x: -50, y: 300, width: 200, height: 100 };
  const clampedRight = clampWindowToDisplayWorkArea(windowNearRight, DISPLAY_1080P_100_SECONDARY_LEFT);

  // x + width <= 0 - 12 = -12 -> x <= -212
  assert.equal(clampedRight.x, -212);
  assert.equal(clampedRight.x + clampedRight.width, -12);
});

test("clampWindowToDisplayWorkArea: clamps on negative-origin display mounted above", () => {
  // Monitor above: workArea.y = -1080, height = 1040 (bottom edge at -40)
  const windowBounds = { x: 300, y: -1200, width: 200, height: 100 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_MONITOR_ABOVE);

  // y must be >= -1080 + 12 = -1068
  assert.equal(clamped.y, -1068);

  // Bottom edge clamping
  const windowNearBottom = { x: 300, y: -50, width: 200, height: 100 };
  const clampedBottom = clampWindowToDisplayWorkArea(windowNearBottom, DISPLAY_MONITOR_ABOVE);
  // workArea bottom = -1080 + 1040 = -40
  // y + height <= -40 - 12 = -52 -> y <= -152
  assert.equal(clampedBottom.y, -152);
  assert.equal(clampedBottom.y + clampedBottom.height, -52);
});

test("clampWindowToDisplayWorkArea: resizes oversized window to fit inside work area", () => {
  const tinyDisplay = {
    workArea: { x: 0, y: 0, width: 500, height: 400 },
    bounds: { x: 0, y: 0, width: 500, height: 400 },
  };
  const hugeWindow = { x: -100, y: -100, width: 800, height: 600 };
  const clamped = clampWindowToDisplayWorkArea(hugeWindow, tinyDisplay, { margin: 12 });

  // width should fit in 500 - 24 = 476, height in 400 - 24 = 376
  assert.equal(clamped.width, 476);
  assert.equal(clamped.height, 376);
  assert.equal(clamped.x, 12);
  assert.equal(clamped.y, 12);
});

test("clampWindowToDisplayWorkArea: works with duck-typed BrowserWindow and calls setBounds", () => {
  const mockWin = createMockBrowserWindow({ x: 10, y: 1000, width: 200, height: 100 });
  const result = clampWindowToDisplayWorkArea(mockWin, DISPLAY_1080P_BOTTOM_TASKBAR);

  assert.equal(mockWin.setBoundsCalls.length, 1);
  assert.equal(mockWin.getBounds().y, 928);
  assert.deepEqual(result, mockWin.getBounds());
});

test("clampWindowToDisplayWorkArea: does not call setBounds if window is already clamped", () => {
  const mockWin = createMockBrowserWindow({ x: 100, y: 100, width: 200, height: 100 });
  clampWindowToDisplayWorkArea(mockWin, DISPLAY_1080P_BOTTOM_TASKBAR);

  assert.equal(mockWin.setBoundsCalls.length, 0);
});

test("clampWindowToDisplayWorkArea: safely returns null for destroyed window", () => {
  const mockWin = createMockBrowserWindow({ x: 100, y: 100, width: 200, height: 100 });
  mockWin.destroy();
  const result = clampWindowToDisplayWorkArea(mockWin, DISPLAY_1080P_BOTTOM_TASKBAR);

  assert.equal(result, null);
  assert.equal(mockWin.setBoundsCalls.length, 0);
});

test("clampWindowToDisplayWorkArea: respects custom margin option", () => {
  const windowBounds = { x: 10, y: 1000, width: 200, height: 100 };
  // With margin 24px, workArea height 1040:
  // y + height <= 1040 - 24 = 1016 -> y <= 916
  const clamped24 = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_BOTTOM_TASKBAR, {
    margin: 24,
  });
  assert.equal(clamped24.y, 916);

  // With margin 0px:
  // y + height <= 1040 -> y <= 940
  const clamped0 = clampWindowToDisplayWorkArea(windowBounds, DISPLAY_1080P_BOTTOM_TASKBAR, {
    margin: 0,
  });
  assert.equal(clamped0.y, 940);
});

test("clampWindowToDisplayWorkArea: falls back to safe default display when none provided", () => {
  const windowBounds = { x: 2500, y: 1500, width: 200, height: 100 };
  const clamped = clampWindowToDisplayWorkArea(windowBounds, null);

  // Should clamp inside default 1920x1080 bounds with 12px margin
  assert.ok(clamped.x <= 1920 - 200 - 12);
  assert.ok(clamped.y <= 1080 - 100 - 12);
  assert.ok(clamped.x >= 12);
  assert.ok(clamped.y >= 12);
});

test("convertDpiCoordinates: moves window from negative-origin display to positive display preserving relative position", () => {
  // Window on left monitor (workArea: -1920 to 0, width 1920), placed at x: -960 (50% across)
  const windowLeft = { x: -960, y: 500, width: 200, height: 100 };

  const converted = convertDpiCoordinates(
    windowLeft,
    DISPLAY_1080P_100_SECONDARY_LEFT,
    DISPLAY_4K_150_PRIMARY
  );

  // Target is 4K 150% (x: 0, width 2560). 50% across is x: 1280.
  assert.equal(converted.x, 1280);
});

test("WindowManager: handles display-added and keeps window visible", async () => {
  let displays = [{ ...DISPLAY_4K_150_PRIMARY }];

  const fakeScreen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: () => displays[0],
    getDisplayNearestPoint: () => displays[0],
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    on: () => {},
    removeListener: () => {},
  };

  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { on: () => undefined },
        screen: fakeScreen,
        BrowserWindow: class {},
        Menu: {},
        dialog: {},
        ipcMain: { on: () => {}, removeListener: () => {} },
      };
    }
    if (request === "./plasmaWorkAreas") {
      return {
        plasmaWorkAreas: {
          start: async () => {},
          refresh: async () => {},
          resolve: (d) => d,
        },
      };
    }
    if (request === "./debugLogger") {
      return { warn: () => {}, debug: () => {}, log: () => {} };
    }
    if (request === "./hotkeyManager") {
      const FakeHotkeyManager = class {
        unregisterAll() {}
      };
      FakeHotkeyManager.isGlobeLikeHotkey = () => false;
      return FakeHotkeyManager;
    }
    if (request === "./menuManager") return { setupMainMenu: () => {} };
    if (request === "./devServerManager") return {};
    if (request === "./dockManager") return {};
    if (request === "./i18nMain") return { i18nMain: { t: (k) => k } };
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve("../../src/helpers/windowManager")];
  const WindowManager = require("../../src/helpers/windowManager");
  Module._load = originalLoad;

  const manager = new WindowManager();
  const mockWin = createMockBrowserWindow({ x: 100, y: 100, width: 208, height: 120 });
  manager.mainWindow = mockWin;
  manager._notifyMainWindowHorizontalDirection = () => {};

  // Window is auto-anchored (not manually positioned)
  assert.equal(manager._mainWindowPlacementCoordinator.hasManualPosition(), false);

  // New display added
  const newSecondaryDisplay = { ...DISPLAY_1080P_100_SECONDARY_RIGHT };
  displays.push(newSecondaryDisplay);

  manager._handleDisplayAdded(newSecondaryDisplay);
  await manager._enqueueMainWindowMutation(() => {});

  const bounds = mockWin.getBounds();
  assert.ok(bounds.x >= 0, "Window x must be >= 0");
  assert.ok(bounds.y >= 0, "Window y must be >= 0");
});

// =========================================================
// Group 2: Mixed DPI & Coordinate Conversion tests
// =========================================================

test("convertDpiCoordinates: converts coordinates when moving from 4K 150% to 1080p 100%", () => {
  // On 4K 150% (workArea width 2560), window is centered at x: 1280 (50% across)
  const windowOn4K = { x: 1280, y: 696, width: 208, height: 120 };

  const converted = convertDpiCoordinates(
    windowOn4K,
    DISPLAY_4K_150_PRIMARY,
    DISPLAY_1080P_100_SECONDARY_RIGHT
  );

  // On secondary display (starts at x: 2560, width 1920), 50% across should land at:
  // 2560 + (1920 * 0.5) = 3520
  assert.equal(converted.x, 3520);
  assert.equal(converted.width, 208);
  assert.equal(converted.height, 120);
});

test("convertDpiCoordinates: prevents coordinate jump off-screen during display transition", () => {
  // Window at right edge of 4K display: x: 2300 (which is > 1920 width of 1080p)
  const windowNearRight4K = { x: 2300, y: 1000, width: 208, height: 120 };

  // Clamping with fromDisplay option converts and clamps safely
  const clamped = clampWindowToDisplayWorkArea(
    windowNearRight4K,
    DISPLAY_1080P_100_SECONDARY_RIGHT,
    { fromDisplay: DISPLAY_4K_150_PRIMARY }
  );

  // Target workArea is x: 2560 to x: 4480
  assert.ok(clamped.x >= 2560 + 12, `x (${clamped.x}) must be >= workArea.x + margin`);
  assert.ok(
    clamped.x + clamped.width <= 2560 + 1920 - 12,
    `x + width (${clamped.x + clamped.width}) must be <= right edge - margin`
  );
  assert.ok(clamped.y >= 0 + 12);
  assert.ok(clamped.y + clamped.height <= 1040 - 12);
});

test("convertDpiCoordinates: handles scale factor change on the same display", () => {
  // e.g. User changes Windows scaling from 100% to 150%
  // 100% scale: width is 3840 DIP, window at x: 3000
  // 150% scale: width is 2560 DIP -> coordinate should scale by 1.0 / 1.5
  const windowAt100 = { x: 3000, y: 1500, width: 200, height: 100 };

  const converted = convertDpiCoordinates(windowAt100, 1.0, 1.5);
  assert.equal(converted.x, 2000);
  assert.equal(converted.y, 1000);
});

test("convertDpiCoordinates: scales window dimensions when scaleSize option is set", () => {
  const bounds = { x: 100, y: 100, width: 300, height: 150 };
  const scaled = convertDpiCoordinates(bounds, 1.0, 1.5, { scaleSize: true });

  assert.equal(scaled.width, 200);
  assert.equal(scaled.height, 100);
});

// =========================================================
// Group 3: MainWindowPlacementCoordinator tests
// =========================================================

test("MainWindowPlacementCoordinator: tracks manual position with displayId and scaleFactor", () => {
  const coordinator = new MainWindowPlacementCoordinator();
  assert.equal(coordinator.hasManualPosition(), false);

  coordinator.markManuallyPositioned(10, { scaleFactor: 1.5 });
  assert.equal(coordinator.hasManualPosition(), true);
  assert.equal(coordinator.getManualDisplayId(), 10);
  assert.equal(coordinator.getLastKnownScaleFactor(), 1.5);

  coordinator.setLastKnownScaleFactor(1.25);
  assert.equal(coordinator.getLastKnownScaleFactor(), 1.25);

  coordinator.resetManualPosition();
  assert.equal(coordinator.hasManualPosition(), false);
  assert.equal(coordinator.getManualDisplayId(), null);
});

test("MainWindowPlacementCoordinator: hasManualPosition(validDisplayIds) detects disconnected display", () => {
  const coordinator = new MainWindowPlacementCoordinator();
  coordinator.markManuallyPositioned(20); // placed on secondary monitor (id: 20)

  // Secondary monitor is still connected:
  assert.equal(coordinator.hasManualPosition([10, 20]), true);

  // Secondary monitor disconnected:
  assert.equal(coordinator.hasManualPosition([10]), false);
});

test("MainWindowPlacementCoordinator: validateManualPosition resets state on display disconnect", () => {
  const coordinator = new MainWindowPlacementCoordinator();
  coordinator.markManuallyPositioned(20);

  const stillValid = coordinator.validateManualPosition([{ id: 10 }]);
  assert.equal(stillValid, false);
  assert.equal(coordinator.hasManualPosition(), false);
  assert.equal(coordinator.getManualDisplayId(), null);
});

test("MainWindowPlacementCoordinator: request with force option overrides manual position", async () => {
  const coordinator = new MainWindowPlacementCoordinator();
  coordinator.markManuallyPositioned(20);

  // Normal request blocked by manual position:
  const normalResult = await coordinator.request(
    () => Promise.resolve({ x: 0, y: 0 }),
    () => ({ applied: true })
  );
  assert.deepEqual(normalResult, { applied: false, reason: "manual-position" });

  // Forced request (e.g. display disconnect / recovery) proceeds:
  const forcedResult = await coordinator.request(
    () => Promise.resolve({ x: 100, y: 100 }),
    (placement) => ({ applied: true, bounds: placement }),
    { force: true }
  );
  assert.deepEqual(forcedResult, { applied: true, bounds: { x: 100, y: 100 } });
});

// =========================================================
// Group 4: WindowManager Display Metrics & Removal Events
// =========================================================

test("WindowManager: handles display-metrics-changed and clamps window within visible work area", async () => {
  let metricsListener = null;
  let removedListener = null;
  let addedListener = null;

  let displays = [
    { ...DISPLAY_4K_150_PRIMARY },
    { ...DISPLAY_1080P_100_SECONDARY_RIGHT },
  ];

  const fakeScreen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: (rect) => (rect.x >= 2560 ? displays[1] : displays[0]),
    getDisplayNearestPoint: (pt) => (pt.x >= 2560 ? displays[1] : displays[0]),
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    on: (evt, cb) => {
      if (evt === "display-metrics-changed") metricsListener = cb;
      if (evt === "display-removed") removedListener = cb;
      if (evt === "display-added") addedListener = cb;
    },
    removeListener: (evt, cb) => {
      if (evt === "display-metrics-changed" && metricsListener === cb) metricsListener = null;
      if (evt === "display-removed" && removedListener === cb) removedListener = null;
      if (evt === "display-added" && addedListener === cb) addedListener = null;
    },
  };

  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { on: () => undefined },
        screen: fakeScreen,
        BrowserWindow: class {},
        Menu: {},
        dialog: {},
        ipcMain: { on: () => {}, removeListener: () => {} },
      };
    }
    if (request === "./plasmaWorkAreas") {
      return {
        plasmaWorkAreas: {
          start: async () => {},
          refresh: async () => {},
          resolve: (d) => d,
        },
      };
    }
    if (request === "./debugLogger") {
      return { warn: () => {}, debug: () => {}, log: () => {} };
    }
    if (request === "./hotkeyManager") {
      const FakeHotkeyManager = class {
        unregisterAll() {}
      };
      FakeHotkeyManager.isGlobeLikeHotkey = () => false;
      return FakeHotkeyManager;
    }
    if (request === "./menuManager") return { setupMainMenu: () => {} };
    if (request === "./devServerManager") return {};
    if (request === "./dockManager") return {};
    if (request === "./i18nMain") return { i18nMain: { t: (k) => k } };
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve("../../src/helpers/windowManager")];
  const WindowManager = require("../../src/helpers/windowManager");
  Module._load = originalLoad;

  const manager = new WindowManager();
  const mockWin = createMockBrowserWindow({ x: 2300, y: 1350, width: 208, height: 120 });
  manager.mainWindow = mockWin;
  manager._notifyMainWindowHorizontalDirection = () => {};

  manager._setupScreenListeners();
  assert.ok(typeof manager._handleDisplayMetricsChanged === "function");
  assert.ok(typeof manager._handleDisplayRemoved === "function");

  // User manually positioned the window near bottom edge of 4K display:
  manager._mainWindowPlacementCoordinator.markManuallyPositioned(10, { scaleFactor: 1.5 });

  // Simulate resolution/metrics change: primary display workArea height drops to 1200
  const updatedPrimaryDisplay = {
    ...DISPLAY_4K_150_PRIMARY,
    workArea: { x: 0, y: 0, width: 2560, height: 1200 },
  };

  manager._handleDisplayMetricsChanged(updatedPrimaryDisplay, ["workArea"]);
  await manager._enqueueMainWindowMutation(() => {});

  // The window (originally y: 1350) must now be clamped inside the new workArea (height: 1200)
  // Max y = 1200 - 120 - 12 = 1068
  const currentBounds = mockWin.getBounds();
  assert.ok(currentBounds.y <= 1068, `Window y (${currentBounds.y}) must be <= 1068`);
  assert.ok(currentBounds.y >= 12, "Window y must be >= 12");
});

test("WindowManager: handles display-removed and recovers window from disconnected display", async () => {
  let displays = [{ ...DISPLAY_4K_150_PRIMARY }]; // Secondary (id: 20) is disconnected!

  const fakeScreen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: () => displays[0],
    getDisplayNearestPoint: () => displays[0],
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    on: () => {},
    removeListener: () => {},
  };

  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { on: () => undefined },
        screen: fakeScreen,
        BrowserWindow: class {},
        Menu: {},
        dialog: {},
        ipcMain: { on: () => {}, removeListener: () => {} },
      };
    }
    if (request === "./plasmaWorkAreas") {
      return {
        plasmaWorkAreas: {
          start: async () => {},
          refresh: async () => {},
          resolve: (d) => d,
        },
      };
    }
    if (request === "./debugLogger") {
      return { warn: () => {}, debug: () => {}, log: () => {} };
    }
    if (request === "./hotkeyManager") {
      const FakeHotkeyManager = class {
        unregisterAll() {}
      };
      FakeHotkeyManager.isGlobeLikeHotkey = () => false;
      return FakeHotkeyManager;
    }
    if (request === "./menuManager") return { setupMainMenu: () => {} };
    if (request === "./devServerManager") return {};
    if (request === "./dockManager") return {};
    if (request === "./i18nMain") return { i18nMain: { t: (k) => k } };
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve("../../src/helpers/windowManager")];
  const WindowManager = require("../../src/helpers/windowManager");
  Module._load = originalLoad;

  const manager = new WindowManager();

  // Window was located on the secondary display (x: 3000)
  const mockWin = createMockBrowserWindow({ x: 3000, y: 500, width: 208, height: 120 });
  manager.mainWindow = mockWin;
  manager._notifyMainWindowHorizontalDirection = () => {};

  // Mark window manually positioned on secondary display 20
  manager._mainWindowPlacementCoordinator.markManuallyPositioned(20, { scaleFactor: 1.0 });
  assert.equal(manager._mainWindowPlacementCoordinator.hasManualPosition(), true);

  // Trigger display-removed for secondary display (id: 20)
  manager._handleDisplayRemoved({ id: 20 });
  await manager._enqueueMainWindowMutation(() => {});

  // 1. Manual position must have been reset because that display was disconnected
  assert.equal(manager._mainWindowPlacementCoordinator.hasManualPosition(), false);

  // 2. Window must now be on the primary display (workArea 0 to 2560, height 1392)
  const newBounds = mockWin.getBounds();
  assert.ok(newBounds.x >= 0, `Window x (${newBounds.x}) must be on primary display >= 0`);
  assert.ok(newBounds.x + newBounds.width <= 2560, `Window x + width must be <= 2560`);
  assert.ok(newBounds.y >= 0, `Window y (${newBounds.y}) must be >= 0`);
  assert.ok(newBounds.y + newBounds.height <= 1392, `Window y + height must be <= 1392`);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAssistantAutoCollapse } = require("../../src/helpers/overlay/assistantAutoCollapse");

function harness(initial = {}) {
  const state = {
    keepOnTop: false,
    open: true,
    busy: false,
    appFocused: false,
    ...initial,
  };
  const timers = [];
  let collapsed = 0;
  const controller = createAssistantAutoCollapse({
    keepOnTop: () => state.keepOnTop,
    isPanelOpen: () => state.open,
    isPanelBusy: () => state.busy,
    isAppFocused: () => state.appFocused,
    collapse: () => {
      collapsed += 1;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  const flush = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
  };
  return { state, controller, flush, timers, collapsed: () => collapsed };
}

test("off by default: leaving for another app folds the panel back to the icon", () => {
  const h = harness();
  h.controller.onBlur();
  assert.equal(h.timers.length, 1);
  assert.ok(h.timers[0].ms > 0, "waits a moment before deciding");
  h.flush();
  assert.equal(h.collapsed(), 1);
});

test("keep on top: blur never folds the panel", () => {
  const h = harness({ keepOnTop: true });
  h.controller.onBlur();
  h.flush();
  assert.equal(h.collapsed(), 0);
});

test("turning keep-on-top on while a check is pending cancels the fold", () => {
  const h = harness();
  h.controller.onBlur();
  h.state.keepOnTop = true;
  h.flush();
  assert.equal(h.collapsed(), 0);
});

test("focus moving to another window of this app keeps the panel", () => {
  const h = harness({ appFocused: true });
  h.controller.onBlur();
  h.flush();
  assert.equal(h.collapsed(), 0);
});

test("coming back before the check runs keeps the panel", () => {
  const h = harness();
  h.controller.onBlur();
  h.controller.onFocus();
  h.flush();
  assert.equal(h.collapsed(), 0);
});

test("a closed panel or an answer still being written is never folded", () => {
  const closed = harness({ open: false });
  closed.controller.onBlur();
  closed.flush();
  assert.equal(closed.collapsed(), 0);

  const busy = harness({ busy: true });
  busy.controller.onBlur();
  busy.flush();
  assert.equal(busy.collapsed(), 0);
});

test("repeated blurs schedule a single check", () => {
  const h = harness();
  h.controller.onBlur();
  h.controller.onBlur();
  h.flush();
  assert.equal(h.collapsed(), 1);
});

// Overlay: with "Keep on top of other apps" off, the answer/search panel folds
// back to the floating icon once the user has moved to another app.
//
// A blur alone is not enough: focus also moves to our own windows (the agent
// dictation pill, the control panel), and Windows can blur and refocus the
// window while it opens. So the check waits a moment and collapses only when
// no window of this app has focus, the panel is still open, and no answer is
// being produced (closing then would cancel the answer the user is waiting for).

const DEFAULT_DELAY_MS = 300;

function createAssistantAutoCollapse({
  keepOnTop,
  isPanelOpen,
  isPanelBusy = () => false,
  isAppFocused,
  collapse,
  delayMs = DEFAULT_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const shouldCollapse = () => !keepOnTop() && isPanelOpen() && !isPanelBusy() && !isAppFocused();

  return {
    onBlur() {
      cancel();
      if (keepOnTop() || !isPanelOpen()) return;
      timer = setTimer(() => {
        timer = null;
        if (shouldCollapse()) collapse();
      }, delayMs);
    },
    onFocus: cancel,
    dispose: cancel,
  };
}

module.exports = { createAssistantAutoCollapse, DEFAULT_DELAY_MS };

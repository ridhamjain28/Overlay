const SAFE_PADDING = 12;

function centeredBounds(current, target, workArea) {
  const width = Math.min(target.width, workArea.width);
  const height = Math.min(target.height, workArea.height);
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  const x = Math.round(
    Math.max(workArea.x, Math.min(centerX - width / 2, workArea.x + workArea.width - width))
  );
  const y = Math.round(
    Math.max(workArea.y, Math.min(centerY - height / 2, workArea.y + workArea.height - height))
  );
  return { x, y, width, height };
}

function clampedBounds(bounds, workArea, margin = 0) {
  const safeMargin = Math.max(0, margin);
  const availableWidth = Math.max(1, workArea.width - safeMargin * 2);
  const availableHeight = Math.max(1, workArea.height - safeMargin * 2);
  const width = Math.min(bounds.width, availableWidth);
  const height = Math.min(bounds.height, availableHeight);
  const minX = workArea.x + safeMargin;
  const maxX = workArea.x + workArea.width - width - safeMargin;
  const minY = workArea.y + safeMargin;
  const maxY = workArea.y + workArea.height - height - safeMargin;
  const x = maxX >= minX ? Math.round(Math.max(minX, Math.min(bounds.x, maxX))) : minX;
  const y = maxY >= minY ? Math.round(Math.max(minY, Math.min(bounds.y, maxY))) : minY;
  return { x, y, width, height };
}

/**
 * Supports DPI scaling factor and multi-monitor coordinate conversions.
 * Converts coordinates when moving between displays with different scale factors
 * or when display metrics/resolution change.
 */
function convertDpiCoordinates(bounds, fromDisplayOrScale, toDisplayOrScale, options = {}) {
  if (!bounds) return bounds;

  const fromScale =
    typeof fromDisplayOrScale === "number"
      ? fromDisplayOrScale
      : fromDisplayOrScale?.scaleFactor || 1.0;
  const toScale =
    typeof toDisplayOrScale === "number"
      ? toDisplayOrScale
      : toDisplayOrScale?.scaleFactor || 1.0;

  const fromWorkArea =
    typeof fromDisplayOrScale === "object" && fromDisplayOrScale !== null
      ? fromDisplayOrScale.workArea || fromDisplayOrScale.bounds
      : null;
  const toWorkArea =
    typeof toDisplayOrScale === "object" && toDisplayOrScale !== null
      ? toDisplayOrScale.workArea || toDisplayOrScale.bounds
      : null;

  let x = bounds.x;
  let y = bounds.y;
  let width = bounds.width;
  let height = bounds.height;

  if (fromWorkArea && toWorkArea) {
    const relX = bounds.x - fromWorkArea.x;
    const relY = bounds.y - fromWorkArea.y;

    if (options.proportional !== false) {
      // Proportional mapping preserves position relative to work area across displays
      const propX = fromWorkArea.width > 0 ? relX / fromWorkArea.width : 0;
      const propY = fromWorkArea.height > 0 ? relY / fromWorkArea.height : 0;
      x = Math.round(toWorkArea.x + propX * toWorkArea.width);
      y = Math.round(toWorkArea.y + propY * toWorkArea.height);
    } else {
      const scaleRatio = fromScale / toScale;
      x = Math.round(toWorkArea.x + relX * scaleRatio);
      y = Math.round(toWorkArea.y + relY * scaleRatio);
    }
  } else if (fromScale && toScale && fromScale !== toScale) {
    const scaleRatio = fromScale / toScale;
    x = Math.round(bounds.x * scaleRatio);
    y = Math.round(bounds.y * scaleRatio);
  }

  if (options.scaleSize && fromScale && toScale && fromScale !== toScale) {
    const scaleRatio = fromScale / toScale;
    width = Math.round(width * scaleRatio);
    height = Math.round(height * scaleRatio);
  }

  return { x, y, width, height };
}

/**
 * Clamps window bounds 100% inside the visible work area of targetDisplay
 * with safe padding (default 12px margin), accounting for taskbars on any side.
 * Supports BrowserWindow instances and plain bounds objects.
 */
function clampWindowToDisplayWorkArea(window, targetDisplay = null, options = {}) {
  if (!window) return null;

  const margin =
    typeof options.margin === "number" ? Math.max(0, options.margin) : SAFE_PADDING;

  let currentBounds;
  const isBrowserWindow = typeof window.getBounds === "function";

  if (isBrowserWindow) {
    if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
      return null;
    }
    currentBounds = window.getBounds();
  } else if (typeof window === "object") {
    currentBounds = { ...window };
  } else {
    return null;
  }

  let display = targetDisplay;
  if (!display) {
    try {
      const electron = require("electron");
      const screen = electron?.screen;
      if (screen) {
        display =
          screen.getDisplayMatching?.(currentBounds) ||
          screen.getDisplayNearestPoint?.({
            x: (currentBounds.x || 0) + (currentBounds.width || 0) / 2,
            y: (currentBounds.y || 0) + (currentBounds.height || 0) / 2,
          }) ||
          screen.getPrimaryDisplay?.();
      }
    } catch {
      // Electron unavailable (e.g. standalone test environment)
    }
  }

  if (!display) {
    display = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1.0,
    };
  }

  let bounds = { ...currentBounds };

  // Convert coordinates across displays or scale factors if requested
  if (options.fromDisplay || (options.fromScale && options.toScale)) {
    bounds = convertDpiCoordinates(
      bounds,
      options.fromDisplay || options.fromScale,
      display || options.toScale,
      options
    );
  }

  const workArea = display.workArea || display.bounds || {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  };

  // Safe padding must not exceed a fraction of the work area
  const maxMarginX = Math.max(0, Math.floor(workArea.width / 4));
  const maxMarginY = Math.max(0, Math.floor(workArea.height / 4));
  const effectiveMarginX = Math.min(margin, maxMarginX);
  const effectiveMarginY = Math.min(margin, maxMarginY);

  const availableWidth = Math.max(1, workArea.width - effectiveMarginX * 2);
  const availableHeight = Math.max(1, workArea.height - effectiveMarginY * 2);

  const width = Math.min(bounds.width != null ? bounds.width : availableWidth, availableWidth);
  const height = Math.min(bounds.height != null ? bounds.height : availableHeight, availableHeight);

  const minX = workArea.x + effectiveMarginX;
  const maxX = workArea.x + workArea.width - width - effectiveMarginX;
  const minY = workArea.y + effectiveMarginY;
  const maxY = workArea.y + workArea.height - height - effectiveMarginY;

  const x = maxX >= minX ? Math.round(Math.max(minX, Math.min(bounds.x != null ? bounds.x : minX, maxX))) : minX;
  const y = maxY >= minY ? Math.round(Math.max(minY, Math.min(bounds.y != null ? bounds.y : minY, maxY))) : minY;

  const clamped = { x, y, width, height };

  if (isBrowserWindow && options.applyBounds !== false) {
    if (
      currentBounds.x !== clamped.x ||
      currentBounds.y !== clamped.y ||
      currentBounds.width !== clamped.width ||
      currentBounds.height !== clamped.height
    ) {
      window.setBounds(clamped);
    }
  }

  return clamped;
}

module.exports = {
  SAFE_PADDING,
  centeredBounds,
  clampedBounds,
  clampWindowToDisplayWorkArea,
  convertDpiCoordinates,
};

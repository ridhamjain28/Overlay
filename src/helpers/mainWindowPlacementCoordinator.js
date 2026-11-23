class MainWindowPlacementCoordinator {
  constructor() {
    this._requestId = 0;
    this._hasManualPosition = false;
    this._manualDisplayId = null;
    this._lastKnownScaleFactor = null;
  }

  cancelPending() {
    this._requestId += 1;
  }

  markManuallyPositioned(displayId = null, metadata = null) {
    this._hasManualPosition = true;
    this._manualDisplayId = displayId;
    if (metadata && typeof metadata.scaleFactor === "number") {
      this._lastKnownScaleFactor = metadata.scaleFactor;
    }
    this.cancelPending();
  }

  hasManualPosition(validDisplayIds = null) {
    if (!this._hasManualPosition) {
      return false;
    }
    if (Array.isArray(validDisplayIds) && this._manualDisplayId !== null) {
      return validDisplayIds.includes(this._manualDisplayId);
    }
    return this._hasManualPosition;
  }

  getManualDisplayId() {
    return this._manualDisplayId;
  }

  getLastKnownScaleFactor() {
    return this._lastKnownScaleFactor;
  }

  setLastKnownScaleFactor(scaleFactor) {
    this._lastKnownScaleFactor = scaleFactor;
  }

  resetManualPosition() {
    this._hasManualPosition = false;
    this._manualDisplayId = null;
    this.cancelPending();
  }

  validateManualPosition(availableDisplays) {
    if (!this._hasManualPosition) return false;
    if (!Array.isArray(availableDisplays) || availableDisplays.length === 0) return true;
    const ids = availableDisplays.map((d) => (d && typeof d === "object" ? d.id : d));
    if (this._manualDisplayId !== null && !ids.includes(this._manualDisplayId)) {
      this.resetManualPosition();
      return false;
    }
    return true;
  }

  async request(resolvePlacement, applyPlacement, options = {}) {
    const force = Boolean(options && options.force);
    if (this._hasManualPosition && !force) {
      return { applied: false, reason: "manual-position" };
    }

    const requestId = ++this._requestId;
    const isCurrent = () =>
      requestId === this._requestId && (!this._hasManualPosition || force);
    const placement = await resolvePlacement();

    if (!isCurrent()) {
      return { applied: false, reason: "superseded" };
    }

    return applyPlacement(placement, isCurrent);
  }
}

module.exports = MainWindowPlacementCoordinator;

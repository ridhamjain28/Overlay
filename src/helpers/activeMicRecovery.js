const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MUTE_GRACE_MS = 1500;
const DEFAULT_RETRY_MS = 2000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 1000;
const SLEEP_RESUME_DELTA_MS = 3000;

const deviceKey = (device) =>
  [device?.deviceId || "", device?.groupId || "", device?.label || ""].join("\u0000");

export const describeAudioInputs = (devices = []) => {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return {
    defaultKey: inputs.length > 0 ? deviceKey(inputs[0]) : "",
    keys: new Set(inputs.map(deviceKey)),
    deviceIds: new Set(inputs.map((device) => device.deviceId).filter(Boolean)),
    groupIds: new Set(inputs.map((device) => device.groupId).filter(Boolean)),
  };
};

export const activeTrackIsAvailable = (track, inputs) => {
  if (!track || track.readyState === "ended") return false;
  const settings = track.getSettings?.() || {};
  if (settings.deviceId && inputs.deviceIds.has(settings.deviceId)) return true;
  if (settings.groupId && inputs.groupIds.has(settings.groupId)) return true;
  // Device labels are not a stable identity, but a live track with no exposed IDs
  // is healthier than guessing that a permission-redacted enumeration removed it.
  return !settings.deviceId && !settings.groupId;
};

/**
 * Emits an audio-device-fallback event so the user/UI is notified when Overlay
 * switches to a fallback microphone (e.g. headset disconnected -> built-in mic).
 */
export function emitAudioDeviceFallback(details = {}) {
  const payload = {
    previousDevice: details.previousDevice || "Headset",
    fallbackDevice: details.fallbackDevice || "Built-in Microphone",
    reason: details.reason || "disconnect",
    timestamp: details.timestamp || Date.now(),
    ...details,
  };

  if (typeof window !== "undefined" && window?.electronAPI?.notifyAudioDeviceFallback) {
    try {
      window.electronAPI.notifyAudioDeviceFallback(payload);
    } catch {}
  }

  if (typeof window !== "undefined" && typeof window?.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("audio-device-fallback", { detail: payload }));
    } catch {}
  }

  return payload;
}

export class ActiveMicRecoveryController {
  constructor({
    mediaDevices,
    acquire,
    acquireFallback,
    onRecovered,
    onStatusChange,
    onFallback,
    getSystemDefault,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    muteGraceMs = DEFAULT_MUTE_GRACE_MS,
    retryMs = DEFAULT_RETRY_MS,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
    watchdogEnabled = true,
  }) {
    this.mediaDevices = mediaDevices;
    this.acquire = acquire;
    this.acquireFallback = acquireFallback || null;
    this.onRecovered = onRecovered;
    this.onStatusChange = onStatusChange;
    this.onFallback = onFallback || null;
    this.getSystemDefault = getSystemDefault || null;
    this.debounceMs = debounceMs;
    this.muteGraceMs = muteGraceMs;
    this.retryMs = retryMs;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.watchdogEnabled = watchdogEnabled;
    this.status = "inactive";
    this.stream = null;
    this.track = null;
    this.followDefault = true;
    this.inputs = describeAudioInputs();
    this.generation = 0;
    this.recoveryPromise = null;
    this.debounceTimer = null;
    this.muteTimer = null;
    this.retryTimer = null;
    this.watchdogTimer = null;
    this.lastWatchdogTick = null;
    this.muteStartTime = null;
    this.started = false;
    this.activeDeviceId = "";
    this.activeDeviceLabel = "";
    this.systemDefaultInfo = null;

    this.onDeviceChange = () => this.scheduleEvaluation();
    this.onTrackEnded = () => this.recover("ended");
    this.onTrackMute = () => {
      if (!this.muteStartTime) {
        this.muteStartTime = Date.now();
      }
      clearTimeout(this.muteTimer);
      this.muteTimer = setTimeout(() => {
        if (this.track?.muted || !this.isTrackHealthy()) {
          this.recover("muted");
        }
      }, this.muteGraceMs);
    };
    this.onTrackUnmute = () => {
      this.muteStartTime = null;
      clearTimeout(this.muteTimer);
    };
  }

  isTrackHealthy() {
    if (!this.track) return false;
    if (this.track.readyState === "ended") return false;
    if (this.track.muted) return false;
    return true;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status);
  }

  async start(stream, { followDefault = true } = {}) {
    this.stop();
    this.started = true;
    this.generation += 1;
    this.followDefault = followDefault;
    this.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    this.attachStream(stream);
    await this.refreshInputs();
    this.startWatchdog();
    if (!this.started) return;
    // The track may have died (or come up muted) before our listeners attached;
    // those events won't replay, so evaluate the track's state directly.
    const alive = this.track && this.track.readyState !== "ended";
    this.setStatus(alive ? "active" : "unavailable");
    if (!alive) {
      this.recover("start");
    } else if (this.track.muted) {
      this.onTrackMute();
    }
  }

  attachStream(stream) {
    this.detachTrack();
    this.stream = stream || null;
    this.track = stream?.getAudioTracks?.()[0] || null;
    this.muteStartTime = this.track?.muted ? Date.now() : null;
    const settings = this.track?.getSettings?.() || {};
    this.activeDeviceId = settings.deviceId || "";
    this.activeDeviceLabel = this.track?.label || "";
    this.track?.addEventListener?.("ended", this.onTrackEnded);
    this.track?.addEventListener?.("mute", this.onTrackMute);
    this.track?.addEventListener?.("unmute", this.onTrackUnmute);
  }

  detachTrack() {
    this.track?.removeEventListener?.("ended", this.onTrackEnded);
    this.track?.removeEventListener?.("mute", this.onTrackMute);
    this.track?.removeEventListener?.("unmute", this.onTrackUnmute);
    this.track = null;
    this.muteStartTime = null;
    clearTimeout(this.muteTimer);
    this.muteTimer = null;
  }

  startWatchdog() {
    this.stopWatchdog();
    if (!this.watchdogEnabled || this.watchdogIntervalMs <= 0) return;
    this.lastWatchdogTick = Date.now();
    this.watchdogTimer = setInterval(() => {
      this.tickWatchdog();
    }, this.watchdogIntervalMs);
    if (this.watchdogTimer?.unref) {
      this.watchdogTimer.unref();
    }
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.lastWatchdogTick = null;
  }

  async tickWatchdog() {
    if (!this.started) return;
    const now = Date.now();

    // 1. Detect resume from sleep (clock jumped significantly)
    if (
      this.lastWatchdogTick &&
      now - this.lastWatchdogTick > Math.max(SLEEP_RESUME_DELTA_MS, this.watchdogIntervalMs * 3)
    ) {
      this.lastWatchdogTick = now;
      await this.evaluateDeviceChange();
      if (!this.isTrackHealthy()) {
        this.recover("sleep-resume");
      }
      return;
    }
    this.lastWatchdogTick = now;

    // 2. Dead track detection
    if (this.track && this.track.readyState === "ended") {
      this.recover("ended");
      return;
    }

    // 3. Track mute duration watchdog (>1.5s)
    if (this.track?.muted) {
      if (!this.muteStartTime) {
        this.muteStartTime = now;
      } else if (now - this.muteStartTime >= this.muteGraceMs) {
        this.recover("muted");
        return;
      }
    } else {
      this.muteStartTime = null;
    }

    // 4. Missing device check (e.g. unplugged USB mic or disconnected Bluetooth)
    if (this.track && !activeTrackIsAvailable(this.track, this.inputs)) {
      this.recover("device-missing");
      return;
    }

    // 5. System default mic change check
    if (this.followDefault && this.getSystemDefault) {
      try {
        const sysDefault = await this.getSystemDefault();
        const prevNative = this.systemDefaultInfo?.nativeId || this.systemDefaultInfo?.name;
        const curNative = sysDefault?.nativeId || sysDefault?.name;
        if (prevNative && curNative && prevNative !== curNative) {
          this.systemDefaultInfo = sysDefault;
          this.recover("default-changed");
          return;
        }
        this.systemDefaultInfo = sysDefault;
      } catch {}
    }
  }

  async refreshInputs() {
    try {
      this.inputs = describeAudioInputs(await this.mediaDevices.enumerateDevices());
      return this.inputs;
    } catch {
      return null;
    }
  }

  scheduleEvaluation() {
    if (!this.started) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.evaluateDeviceChange(), this.debounceMs);
  }

  async evaluateDeviceChange() {
    if (!this.started) return;
    const previous = this.inputs;
    const current = await this.refreshInputs();
    if (!this.started || !current) {
      if (this.track?.readyState === "ended") this.recover("devicechange-ended");
      return;
    }

    const defaultChanged = previous.defaultKey !== current.defaultKey;
    const activeMissing = !activeTrackIsAvailable(this.track, current);
    if ((this.followDefault && defaultChanged) || activeMissing || this.status === "unavailable") {
      this.recover(activeMissing ? "device-missing" : "devicechange");
    }
  }

  notifyFallback(details = {}) {
    const payload = {
      previousDevice: details.previousDevice || this.activeDeviceLabel || "Headset",
      fallbackDevice: details.fallbackDevice || "Default Microphone",
      reason: details.reason || "disconnect",
      timestamp: Date.now(),
      ...details,
    };
    this.onFallback?.(payload);
    emitAudioDeviceFallback(payload);
    return payload;
  }

  recover(reason) {
    if (!this.started) return Promise.resolve(false);
    if (this.recoveryPromise) return this.recoveryPromise;

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = this.generation;
    const oldStream = this.stream;
    const prevLabel = this.activeDeviceLabel || this.track?.label || "microphone";
    const prevId = this.activeDeviceId || this.track?.getSettings?.()?.deviceId || "";
    this.setStatus("reconnecting");

    const attempt = async () => {
      let replacement = null;
      let usedFallback = false;
      try {
        try {
          replacement = await this.acquire(reason);
        } catch (acquireErr) {
          if (this.acquireFallback) {
            replacement = await this.acquireFallback(reason, acquireErr);
            usedFallback = true;
          } else {
            throw acquireErr;
          }
        }

        if (!replacement?.getAudioTracks?.()[0]) throw new Error("No audio track returned");
        if (!this.started || generation !== this.generation) {
          replacement.getTracks?.().forEach((track) => track.stop());
          return false;
        }
        await this.onRecovered(replacement, oldStream, reason);
        if (!this.started || generation !== this.generation) {
          replacement.getTracks?.().forEach((track) => track.stop());
          return false;
        }
        this.attachStream(replacement);
        await this.refreshInputs();
        this.setStatus("active");

        const nextTrack = replacement.getAudioTracks()[0];
        const nextLabel = nextTrack?.label || "Built-in Microphone";
        const nextId = nextTrack?.getSettings?.()?.deviceId || "";
        const isDeviceSwitch = prevId && nextId && prevId !== nextId;
        const isLabelSwitch = prevLabel && nextLabel && prevLabel !== nextLabel;

        if (
          usedFallback ||
          reason === "device-missing" ||
          reason === "muted" ||
          reason === "fallback" ||
          isDeviceSwitch ||
          isLabelSwitch
        ) {
          this.notifyFallback({
            previousDevice: prevLabel,
            fallbackDevice: nextLabel,
            reason: reason || "fallback",
          });
        }

        return true;
      } catch {
        if (replacement && replacement !== this.stream) {
          replacement.getTracks?.().forEach((track) => track.stop());
        }
        if (this.started && generation === this.generation) {
          this.setStatus("unavailable");
          this.scheduleRetry();
        }
        return false;
      }
    };
    // Only clear our own handle: a stale attempt settling after stop()+start()
    // must not clobber a newer in-flight recovery's dedup handle.
    const promise = attempt().finally(() => {
      if (this.recoveryPromise === promise) this.recoveryPromise = null;
    });
    this.recoveryPromise = promise;
    return promise;
  }

  scheduleRetry() {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.recover("retry");
    }, this.retryMs);
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.stopWatchdog();
    this.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.detachTrack();
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.muteTimer);
    this.debounceTimer = null;
    this.retryTimer = null;
    this.muteTimer = null;
    this.recoveryPromise = null;
    this.stream = null;
    this.setStatus("inactive");
  }
}


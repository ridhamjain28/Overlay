import { useCallback, useEffect, useRef, useState } from "react";
import type { OverlayAppsScanProgress, ScanResult } from "../types/overlayApps";
import { errorMessage, getOverlayAppsApi } from "../utils/overlayApps";

export type OverlayAppsScanStatus = "idle" | "scanning" | "done" | "error" | "unavailable";

export interface OverlayAppsScanState {
  status: OverlayAppsScanStatus;
  progress: OverlayAppsScanProgress | null;
  result: ScanResult | null;
  error: string | null;
}

/**
 * Runs overlayApps.scan() and follows onScanProgress while it runs.
 *
 * The progress subscription lives exactly as long as the component: it is
 * removed on unmount, and a scan that finishes after unmount never sets state.
 * With `autoStart` the scan begins on mount (once, even under StrictMode's
 * double-invoked effects); otherwise call `run()`.
 */
export function useOverlayAppsScan(autoStart: boolean) {
  const [state, setState] = useState<OverlayAppsScanState>(() => ({
    status: getOverlayAppsApi() ? "idle" : "unavailable",
    progress: null,
    result: null,
    error: null,
  }));
  const mountedRef = useRef(false);
  const runningRef = useRef(false);
  const startedRef = useRef(false);

  const run = useCallback(async (): Promise<ScanResult | null> => {
    const api = getOverlayAppsApi();
    if (!api) {
      setState((prev) => ({ ...prev, status: "unavailable" }));
      return null;
    }
    if (runningRef.current) return null;
    runningRef.current = true;
    setState((prev) => ({ ...prev, status: "scanning", progress: null, error: null }));
    try {
      const result = await api.scan();
      if (mountedRef.current) {
        setState({ status: "done", progress: null, result, error: null });
      }
      return result;
    } catch (error) {
      if (mountedRef.current) {
        setState((prev) => ({
          ...prev,
          status: "error",
          progress: null,
          error: errorMessage(error),
        }));
      }
      return null;
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const api = getOverlayAppsApi();
    const unsubscribe = api?.onScanProgress((progress) => {
      if (mountedRef.current) setState((prev) => ({ ...prev, progress }));
    });
    if (autoStart && !startedRef.current) {
      startedRef.current = true;
      void run();
    }
    return () => {
      mountedRef.current = false;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [autoStart, run]);

  return { ...state, run };
}

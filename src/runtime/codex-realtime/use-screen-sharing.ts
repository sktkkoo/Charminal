import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ScreenCaptureSource,
  screenAnnotationBegin,
  screenAnnotationClear,
  screenAnnotationDocument,
  screenAnnotationEnd,
  screenCaptureFrame,
  screenCaptureListSources,
  screenCaptureRequestPermission,
} from "../../bindings/tauri-commands";
import type { ScreenObservationFrame, ScreenObservationResult } from "./screen-observation";

interface Options {
  available: boolean;
  /** Changes on main-agent/thread replacement; voice reconnection keeps this lease. */
  ownerKey: string;
  share: (frame: ScreenObservationFrame, signal: AbortSignal) => Promise<ScreenObservationResult>;
  /** Durations only; never receives pixels, labels, thread IDs, or lease tokens. */
  onTiming?: (timing: ScreenSharingTiming) => void;
}

export interface ScreenSharingTiming {
  readonly reason: "periodic" | "speech";
  readonly captureMs: number;
  readonly contextMs: number;
  readonly totalMs: number;
  readonly outcome: "shared" | "unchanged" | "busy" | "cancelled" | "failed";
}

interface SharingLease {
  readonly shareId: string;
  readonly documentId: Promise<string>;
  readonly sourceId: number;
  readonly ownerKey: string;
  readonly controller: AbortController;
  ready: boolean;
}

// A cancelled native begin may still complete. Serialize begins across hook
// lifetimes, including React remounts, so it cannot replace a newer sharing lease.
let annotationBeginQueue: Promise<void> = Promise.resolve();

// Native rotates this epoch when the main WebView reloads. One lookup per JS
// document prevents a Start waiting on permission from borrowing a new epoch.
let annotationDocument: Promise<string> | null = null;

export function getAnnotationDocument(): Promise<string> {
  if (annotationDocument) return annotationDocument;
  const pending = Promise.resolve()
    .then(() => screenAnnotationDocument())
    .catch((failure) => {
      if (annotationDocument === pending) annotationDocument = null;
      throw failure;
    });
  annotationDocument = pending;
  return pending;
}

/** Host-owned opt-in sampling; no queued frames, no capture after a stale permission grant. */
export function useScreenSharing({ available, ownerKey, share, onTiming }: Options) {
  const [sources, setSources] = useState<ScreenCaptureSource[]>([]);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastObservedAt, setLastObservedAt] = useState<number>();
  const owner = useRef<SharingLease | null>(null);
  const inFlight = useRef<{ lease: SharingLease; promise: Promise<void> } | null>(null);
  const lastImage = useRef<{ dataUrl: string; frameId: string } | null>(null);
  const lastCaptureStartedAt = useRef<number | null>(null);
  const latest = useRef({ available, ownerKey, share, onTiming, intervalSeconds });
  latest.current = { available, ownerKey, share, onTiming, intervalSeconds };

  const stop = useCallback(() => {
    const lease = owner.current;
    lease?.controller.abort();
    owner.current = null;
    lastImage.current = null;
    lastCaptureStartedAt.current = null;
    setActive(false);
    setBusy(false);
    if (lease) {
      // End is token scoped. A delayed reply cannot revoke a subsequent Start.
      void screenAnnotationEnd(lease.shareId).catch(() => {
        if (owner.current === null && latest.current.ownerKey === lease.ownerKey) {
          setError("Could not clear the screen markers.");
        }
      });
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing either owner or availability ends the sharing lease.
  useEffect(() => {
    stop();
    setLastObservedAt(undefined);
    return stop;
  }, [ownerKey, available, stop]);

  const refreshSources = useCallback(async () => {
    const key = latest.current.ownerKey;
    try {
      const next = await screenCaptureListSources();
      if (latest.current.ownerKey !== key) return;
      const sourceLost =
        owner.current !== null && !next.some((source) => source.id === owner.current?.sourceId);
      if (sourceLost) stop();
      setSources(next);
      setSourceId((current) =>
        next.some((source) => source.id === current) ? current : (next[0]?.id ?? null),
      );
      setError(
        sourceLost
          ? "The shared display is no longer available. Select a display and start sharing again."
          : undefined,
      );
    } catch (failure) {
      if (latest.current.ownerKey === key) setError(String(failure));
    }
  }, [stop]);

  const start = useCallback(async () => {
    if (!latest.current.available || sourceId === null || owner.current) return;
    const lease: SharingLease = {
      shareId: crypto.randomUUID(),
      documentId: getAnnotationDocument(),
      sourceId,
      ownerKey: latest.current.ownerKey,
      controller: new AbortController(),
      ready: false,
    };
    owner.current = lease;
    const isCurrent = () =>
      !lease.controller.signal.aborted &&
      owner.current === lease &&
      latest.current.ownerKey === lease.ownerKey &&
      latest.current.available;
    setError(undefined);
    setBusy(true);
    setLastObservedAt(undefined);
    try {
      const documentId = await lease.documentId;
      if (!isCurrent()) return;
      const granted = await screenCaptureRequestPermission();
      if (!isCurrent()) return;
      if (!granted)
        throw new Error(
          "Screen Recording permission is required. Allow Yorishiro in System Settings → Privacy & Security → Screen Recording, then retry.",
        );
      const beginning = annotationBeginQueue.then(async () => {
        if (!isCurrent()) return;
        try {
          await screenAnnotationBegin(lease.shareId, lease.sourceId, documentId);
        } finally {
          // Stop may have reached native before this in-flight begin. Revoke it
          // again before allowing another begin through the queue.
          if (!isCurrent()) await screenAnnotationEnd(lease.shareId);
        }
      });
      annotationBeginQueue = beginning.catch(() => {});
      await beginning;
      if (!isCurrent()) return;
      lease.ready = true;
      setActive(true);
    } catch (failure) {
      if (!isCurrent()) return;
      stop();
      setError(String(failure));
    } finally {
      if (owner.current === lease) setBusy(false);
    }
  }, [sourceId, stop]);

  const capture = useCallback(
    function requestCapture(reason: ScreenSharingTiming["reason"]): Promise<void> {
      const lease = owner.current;
      if (!lease?.ready) return Promise.resolve();
      const isCurrent = () =>
        owner.current === lease &&
        !lease.controller.signal.aborted &&
        latest.current.ownerKey === lease.ownerKey &&
        latest.current.available;
      if (!isCurrent()) return Promise.resolve();
      const pending = inFlight.current;
      if (pending) {
        // Speech joins an existing capture. A new lease waits for the previous
        // native operation to settle, then starts immediately instead of losing
        // its first capture until the next periodic tick.
        return pending.lease === lease
          ? pending.promise
          : pending.promise.then(() => {
              if (isCurrent()) return requestCapture(reason);
            });
      }
      // Moving the slider reschedules this effect. It must not capture at every
      // slider step. Speech explicitly bypasses this periodic sampling limit so
      // the screenshot can reach Codex while the user is still asking a question.
      const now = Date.now();
      if (
        reason === "periodic" &&
        lastCaptureStartedAt.current !== null &&
        now - lastCaptureStartedAt.current < latest.current.intervalSeconds * 1000
      )
        return Promise.resolve();
      lastCaptureStartedAt.current = now;
      const run = { lease, promise: Promise.resolve() };
      inFlight.current = run;
      setBusy(true);
      run.promise = (async () => {
        const started = performance.now();
        let captured: number | null = null;
        let outcome: ScreenSharingTiming["outcome"] = "cancelled";
        try {
          const frame = await screenCaptureFrame(lease.sourceId, lease.shareId);
          captured = performance.now();
          if (!isCurrent()) return;
          if (frame.sourceId !== lease.sourceId) {
            throw new Error(
              "The shared display changed. Start sharing the selected display again.",
            );
          }
          // Reuse identical pixels while their native reference remains valid. A
          // replacement token (for example after sleep/expiry) must reach the agent.
          if (
            lastImage.current?.dataUrl === frame.dataUrl &&
            lastImage.current.frameId === frame.frameId
          ) {
            outcome = "unchanged";
            return;
          }
          const result = await latest.current.share(
            {
              frameId: frame.frameId,
              pointersEnabled: frame.pointersEnabled,
              pointerFrameValid: frame.pointerFrameValid,
              pointerEpoch: frame.pointerEpoch,
              width: frame.width,
              height: frame.height,
              imageDataUrl: frame.dataUrl,
              source: frame.sourceName,
              capturedAt: new Date(frame.capturedAt).toISOString(),
            },
            lease.controller.signal,
          );
          if (!isCurrent()) return;
          outcome = result.status;
          if (result.status === "shared") {
            lastImage.current = { dataUrl: frame.dataUrl, frameId: frame.frameId };
            setLastObservedAt(frame.capturedAt);
          }
        } catch (failure) {
          if (!isCurrent()) return;
          outcome = "failed";
          stop();
          setError(String(failure));
        } finally {
          if (inFlight.current === run) inFlight.current = null;
          if (isCurrent()) setBusy(false);
          const ended = performance.now();
          try {
            latest.current.onTiming?.({
              reason,
              captureMs: (captured ?? ended) - started,
              contextMs: captured === null ? 0 : ended - captured,
              totalMs: ended - started,
              outcome,
            });
          } catch {
            // Diagnostics must never interrupt sharing or voice.
          }
        }
      })();
      return run.promise;
    },
    [stop],
  );

  const captureNow = useCallback(() => capture("speech"), [capture]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    const tick = async () => {
      await capture("periodic");
      if (disposed) return;
      // A slow capture resumes at its next due time; no extra whole interval is
      // added because an interval tick arrived while capture was in flight.
      const nextDue = (lastCaptureStartedAt.current ?? Date.now()) + intervalSeconds * 1000;
      timer = window.setTimeout(() => void tick(), Math.max(0, nextDue - Date.now()));
    };
    void tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [active, intervalSeconds, capture]);

  const clearAnnotations = useCallback(async () => {
    const lease = owner.current;
    if (!lease) return;
    try {
      await screenAnnotationClear();
      if (owner.current === lease) setError(undefined);
    } catch {
      if (owner.current === lease) setError("Could not clear the screen markers.");
    }
  }, []);

  return {
    sources,
    sourceId,
    intervalSeconds,
    active,
    busy,
    error,
    lastObservedAt,
    start,
    stop,
    captureNow,
    clearAnnotations,
    refreshSources,
    setSourceId: (value: number) => {
      if (!owner.current) setSourceId(value);
    },
    setIntervalSeconds: (value: number) => {
      if (Number.isFinite(value)) setIntervalSeconds(Math.max(5, Math.min(60, Math.round(value))));
    },
  };
}

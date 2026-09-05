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
}

interface SharingLease {
  readonly shareId: string;
  readonly documentId: Promise<string>;
  readonly sourceId: number;
  readonly ownerKey: string;
  readonly controller: AbortController;
}

// A cancelled native begin may still complete. Serialize begins across hook
// lifetimes, including React remounts, so it cannot replace a newer sharing lease.
let annotationBeginQueue: Promise<void> = Promise.resolve();

// Native rotates this epoch when the main WebView reloads. One lookup per JS
// document prevents a Start waiting on permission from borrowing a new epoch.
let annotationDocument: Promise<string> | null = null;

function getAnnotationDocument(): Promise<string> {
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
export function useScreenSharing({ available, ownerKey, share }: Options) {
  const [sources, setSources] = useState<ScreenCaptureSource[]>([]);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastObservedAt, setLastObservedAt] = useState<number>();
  const owner = useRef<SharingLease | null>(null);
  const inFlight = useRef(false);
  const lastImage = useRef<{ dataUrl: string; frameId: string } | null>(null);
  const lastCaptureStartedAt = useRef<number | null>(null);
  const latest = useRef({ available, ownerKey, share });
  latest.current = { available, ownerKey, share };

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
      setActive(true);
    } catch (failure) {
      if (!isCurrent()) return;
      stop();
      setError(String(failure));
    } finally {
      if (owner.current === lease) setBusy(false);
    }
  }, [sourceId, stop]);

  useEffect(() => {
    const lease = owner.current;
    if (!active || sourceId === null || !lease) return;
    const key = ownerKey;
    const isCurrent = () =>
      owner.current === lease &&
      !lease.controller.signal.aborted &&
      latest.current.ownerKey === key &&
      latest.current.available;
    const tick = async () => {
      if (!isCurrent() || inFlight.current) return;
      // Moving the slider reschedules this effect. It must not capture at every
      // slider step (which can otherwise send dozens of images per second).
      const now = Date.now();
      if (
        lastCaptureStartedAt.current !== null &&
        now - lastCaptureStartedAt.current < intervalSeconds * 1000
      )
        return;
      lastCaptureStartedAt.current = now;
      inFlight.current = true;
      setBusy(true);
      try {
        const frame = await screenCaptureFrame(lease.sourceId, lease.shareId);
        if (!isCurrent()) return;
        if (frame.sourceId !== lease.sourceId) {
          throw new Error("The shared display changed. Start sharing the selected display again.");
        }
        // Reuse identical pixels while their native reference remains valid. A
        // replacement token (for example after sleep/expiry) must reach the agent.
        if (
          lastImage.current?.dataUrl === frame.dataUrl &&
          lastImage.current.frameId === frame.frameId
        )
          return;
        const result = await latest.current.share(
          {
            frameId: frame.frameId,
            width: frame.width,
            height: frame.height,
            imageDataUrl: frame.dataUrl,
            source: frame.sourceName,
            capturedAt: new Date(frame.capturedAt).toISOString(),
          },
          lease.controller.signal,
        );
        if (!isCurrent()) return;
        if (result.status === "shared") {
          lastImage.current = { dataUrl: frame.dataUrl, frameId: frame.frameId };
          setLastObservedAt(frame.capturedAt);
        }
      } catch (failure) {
        if (!isCurrent()) return;
        stop();
        setError(String(failure));
      } finally {
        inFlight.current = false;
        if (isCurrent()) setBusy(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), intervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [active, sourceId, intervalSeconds, ownerKey, stop]);

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

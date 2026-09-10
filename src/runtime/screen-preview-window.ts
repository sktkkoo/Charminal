import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

export const PREVIEW_WINDOW_LABEL = "auxiliary-screen-preview";
export const PREVIEW_STATE_EVENT = "screen-preview-state";
const PREVIEW_ACTION_EVENT = "screen-preview-action";
export interface ScreenPreviewFrame {
  leaseId: string;
  imageDataUrl: string;
  lastCapturedAt?: number;
  lastSharedAt?: number;
  language: string;
  sequence?: number;
}
interface PreviewAction {
  leaseId: string;
  action: "stop" | "attach";
}
export function listenScreenPreview(
  callback: (frame: ScreenPreviewFrame | null) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<ScreenPreviewFrame | null>(PREVIEW_STATE_EVENT, (event) =>
    callback(event.payload),
  );
}
export function readScreenPreview(): Promise<ScreenPreviewFrame | null> {
  return invoke("screen_preview_snapshot");
}
export function requestScreenPreviewAction(
  leaseId: string,
  action: "stop" | "attach",
): Promise<void> {
  return invoke("screen_preview_request_action", { leaseId, action });
}
export interface ScreenPreviewModel {
  sourceKey: string | null;
  frame: { imageDataUrl: string; lastCapturedAt?: number; lastSharedAt?: number } | null;
  language: string;
  onStop: () => void;
}
interface PreviewStatus {
  detached: boolean;
  opening: boolean;
  error?: string;
}
interface PreviewTransport {
  begin: () => Promise<string>;
  open: (leaseId: string) => Promise<void>;
  revoke: (leaseId: string) => Promise<void>;
  publish: (frame: ScreenPreviewFrame) => Promise<void>;
  listen: (callback: (action: PreviewAction) => void) => Promise<() => void>;
}
const nativeTransport: PreviewTransport = {
  begin: () => invoke("screen_preview_begin"),
  open: (leaseId) => invoke("screen_preview_open", { leaseId }),
  revoke: (leaseId) => invoke("screen_preview_revoke", { leaseId }),
  publish: (frame) => invoke("screen_preview_publish", { frame }),
  listen: (callback) =>
    getCurrentWindow().listen<PreviewAction>(PREVIEW_ACTION_EVENT, (event) =>
      callback(event.payload),
    ),
};

/** Relays only the latest successfully shared still; never captures or sends context. */
export function startScreenPreviewRelay(
  _sourceKey: string,
  frame: () => ScreenPreviewFrame | null,
  publish: (frame: ScreenPreviewFrame) => Promise<void>,
  fail: (error: unknown) => void,
): () => void {
  let stopped = false;
  let inFlight = false;
  let lastImage: string | undefined;
  let lastSharedAt: number | undefined;
  let lastLanguage: string | undefined;
  const tick = () => {
    if (stopped || inFlight) return;
    const next = frame();
    if (
      !next ||
      (next.imageDataUrl === lastImage &&
        next.lastSharedAt === lastSharedAt &&
        next.language === lastLanguage)
    )
      return;
    inFlight = true;
    void publish(next)
      .then(() => {
        lastImage = next.imageDataUrl;
        lastSharedAt = next.lastSharedAt;
        lastLanguage = next.language;
      })
      .catch((error: unknown) => {
        if (!stopped) fail(error);
      })
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, 125);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    lastImage = undefined;
  };
}

// Also serializes owners across React remounts, including StrictMode cleanup.
let lifecycle: Promise<void> = Promise.resolve();
interface Attempt {
  sourceKey: string;
  leaseId?: string;
  cancelled: boolean;
  cleanup?: () => void;
}
export class ScreenPreviewHost {
  private attempt: Attempt | null = null;
  private disposed = false;
  private model: ScreenPreviewModel;
  private unlisten?: () => void;
  private listening?: Promise<void>;
  constructor(
    model: ScreenPreviewModel,
    private readonly changed: (state: PreviewStatus) => void,
    private readonly transport: PreviewTransport = nativeTransport,
    private readonly relay = startScreenPreviewRelay,
  ) {
    this.model = model;
  }

  update(model: ScreenPreviewModel): void {
    const previous = this.model.sourceKey;
    this.model = model;
    if (previous !== model.sourceKey) void this.attach().catch(() => {});
  }
  private current(attempt: Attempt): boolean {
    return (
      !this.disposed &&
      !attempt.cancelled &&
      this.attempt === attempt &&
      this.model.sourceKey === attempt.sourceKey
    );
  }
  private async ensureListening(): Promise<void> {
    if (this.unlisten) return;
    if (!this.listening) {
      this.listening = this.transport
        .listen((request) => {
          const attempt = this.attempt;
          if (!attempt || !this.current(attempt) || request.leaseId !== attempt.leaseId) return;
          if (request.action !== "attach" && request.action !== "stop") return;
          const stop = request.action === "stop";
          void this.attach().catch(() => {});
          if (stop) this.model.onStop();
        })
        .then((unlisten) => {
          if (this.disposed) unlisten();
          else this.unlisten = unlisten;
        })
        .catch((error: unknown) => {
          this.listening = undefined;
          throw error;
        });
    }
    await this.listening;
  }
  detach(): Promise<void> {
    if (this.disposed || !this.model.sourceKey || this.attempt) return Promise.resolve();
    const attempt: Attempt = { sourceKey: this.model.sourceKey, cancelled: false };
    this.attempt = attempt;
    this.changed({ detached: false, opening: true });
    const operation = lifecycle
      .catch(() => {})
      .then(async () => {
        try {
          if (!this.current(attempt)) return;
          await this.ensureListening();
          if (!this.current(attempt)) return;
          attempt.leaseId = await this.transport.begin();
          if (!this.current(attempt)) {
            await this.transport.revoke(attempt.leaseId);
            return;
          }
          await this.transport.open(attempt.leaseId);
          if (!this.current(attempt)) {
            await this.transport.revoke(attempt.leaseId);
            return;
          }
          attempt.cleanup = this.relay(
            attempt.sourceKey,
            () =>
              this.model.frame
                ? {
                    ...this.model.frame,
                    leaseId: attempt.leaseId as string,
                    language: this.model.language.startsWith("ja") ? "ja" : "en",
                  }
                : null,
            (frame) => (this.current(attempt) ? this.transport.publish(frame) : Promise.resolve()),
            (error) => {
              if (this.current(attempt))
                void this.attach()
                  .finally(() => {
                    if (!this.disposed && !this.attempt)
                      this.changed({ detached: false, opening: false, error: String(error) });
                  })
                  .catch(() => {});
            },
          );
          this.changed({ detached: true, opening: false });
        } catch (error) {
          const wasCurrent = this.current(attempt);
          attempt.cancelled = true;
          attempt.cleanup?.();
          if (this.attempt === attempt) this.attempt = null;
          if (attempt.leaseId) await this.transport.revoke(attempt.leaseId).catch(() => {});
          if (wasCurrent) {
            this.changed({ detached: false, opening: false, error: String(error) });
            throw error;
          }
        }
      });
    lifecycle = operation.catch(() => {});
    return operation;
  }
  attach(): Promise<void> {
    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) {
      attempt.cancelled = true;
      attempt.cleanup?.();
    }
    if (!this.disposed) this.changed({ detached: false, opening: false });
    // Revoke immediately even if native open is still pending; native serializes it with creation.
    const revoke = attempt?.leaseId ? this.transport.revoke(attempt.leaseId) : Promise.resolve();
    const operation = Promise.all([lifecycle, revoke]).then(() => {});
    lifecycle = operation.catch(() => {});
    return operation;
  }
  dispose(): void {
    this.disposed = true;
    void this.attach().catch(() => {});
    this.unlisten?.();
    this.unlisten = undefined;
  }
}
export function useScreenPreviewWindow(model: ScreenPreviewModel) {
  const latest = useRef(model);
  latest.current = model;
  const host = useRef<ScreenPreviewHost | null>(null);
  const [status, setStatus] = useState<PreviewStatus>({ detached: false, opening: false });
  useEffect(() => {
    const owner = new ScreenPreviewHost(latest.current, setStatus);
    host.current = owner;
    return () => {
      if (host.current === owner) host.current = null;
      owner.dispose();
    };
  }, []);
  // The action handler consults this ref-backed model before accepting native actions.
  useEffect(() => {
    host.current?.update(model);
  }, [model]);
  const detach = useCallback(async () => {
    await host.current?.detach();
  }, []);
  const attach = useCallback(async () => {
    await host.current?.attach();
  }, []);
  return { ...status, detach, attach };
}

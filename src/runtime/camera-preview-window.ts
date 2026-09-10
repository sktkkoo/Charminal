import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

export const PREVIEW_WINDOW_LABEL = "auxiliary-camera-preview";
export const PREVIEW_STATE_EVENT = "camera-preview-state";
const PREVIEW_ACTION_EVENT = "camera-preview-action";
export interface CameraPreviewFrame {
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
export function listenCameraPreview(
  callback: (frame: CameraPreviewFrame | null) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<CameraPreviewFrame | null>(PREVIEW_STATE_EVENT, (event) =>
    callback(event.payload),
  );
}
export function readCameraPreview(): Promise<CameraPreviewFrame | null> {
  return invoke("camera_preview_snapshot");
}
export function requestCameraPreviewAction(
  leaseId: string,
  action: "stop" | "attach",
): Promise<void> {
  return invoke("camera_preview_request_action", { leaseId, action });
}
export interface CameraPreviewModel {
  stream: MediaStream | null;
  lastCapturedAt?: number;
  lastSharedAt?: number;
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
  publish: (frame: CameraPreviewFrame) => Promise<void>;
  listen: (callback: (action: PreviewAction) => void) => Promise<() => void>;
}
const nativeTransport: PreviewTransport = {
  begin: () => invoke("camera_preview_begin"),
  open: (leaseId) => invoke("camera_preview_open", { leaseId }),
  revoke: (leaseId) => invoke("camera_preview_revoke", { leaseId }),
  publish: (frame) => invoke("camera_preview_publish", { frame }),
  listen: (callback) =>
    getCurrentWindow().listen<PreviewAction>(PREVIEW_ACTION_EVENT, (event) =>
      callback(event.payload),
    ),
};

/** Only projects the existing stream; does not acquire, stop, or share camera tracks. */
export function startCameraPreviewRelay(
  stream: MediaStream,
  frame: () => Omit<CameraPreviewFrame, "imageDataUrl">,
  publish: (frame: CameraPreviewFrame) => Promise<void>,
  fail: (error: unknown) => void,
): () => void {
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  let stopped = false;
  let inFlight = false;
  const readyDeadline = setTimeout(() => {
    if (!stopped && video.readyState < 2)
      fail(new Error("The camera preview did not become ready."));
  }, 5000);
  const context = canvas.getContext("2d");
  const timer = setInterval(() => {
    if (stopped || inFlight || video.readyState < 2 || !video.videoWidth || !video.videoHeight)
      return;
    if (!context) {
      fail(new Error("Camera preview is unavailable."));
      return;
    }
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageDataUrl = canvas.toDataURL("image/jpeg", 0.65);
      if (!imageDataUrl.startsWith("data:image/jpeg;base64,") || imageDataUrl.length > 349550) {
        throw new Error("Camera preview image is unavailable.");
      }
      inFlight = true;
      void publish({ ...frame(), imageDataUrl })
        .catch((error: unknown) => {
          if (!stopped) fail(error);
        })
        .finally(() => {
          inFlight = false;
        });
    } catch (error) {
      if (!stopped) fail(error);
    }
  }, 125);
  void video.play().catch((error: unknown) => {
    if (!stopped) fail(error);
  });
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(readyDeadline);
    video.pause();
    video.srcObject = null;
    canvas.width = 0;
    canvas.height = 0;
  };
}

// Also serializes owners across React remounts, including StrictMode cleanup.
let lifecycle: Promise<void> = Promise.resolve();
interface Attempt {
  stream: MediaStream;
  leaseId?: string;
  cancelled: boolean;
  cleanup?: () => void;
}
export class CameraPreviewHost {
  private attempt: Attempt | null = null;
  private disposed = false;
  private model: CameraPreviewModel;
  private unlisten?: () => void;
  private listening?: Promise<void>;
  constructor(
    model: CameraPreviewModel,
    private readonly changed: (state: PreviewStatus) => void,
    private readonly transport: PreviewTransport = nativeTransport,
    private readonly relay = startCameraPreviewRelay,
  ) {
    this.model = model;
  }

  update(model: CameraPreviewModel): void {
    const previous = this.model.stream;
    this.model = model;
    if (previous !== model.stream) void this.attach().catch(() => {});
  }
  private current(attempt: Attempt): boolean {
    return (
      !this.disposed &&
      !attempt.cancelled &&
      this.attempt === attempt &&
      this.model.stream === attempt.stream
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
    if (this.disposed || !this.model.stream || this.attempt) return Promise.resolve();
    const attempt: Attempt = { stream: this.model.stream, cancelled: false };
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
            attempt.stream,
            () => ({
              leaseId: attempt.leaseId as string,
              language: this.model.language.startsWith("ja") ? "ja" : "en",
              lastCapturedAt: finiteTimestamp(this.model.lastCapturedAt),
              lastSharedAt: finiteTimestamp(this.model.lastSharedAt),
            }),
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
function finiteTimestamp(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}
export function useCameraPreviewWindow(model: CameraPreviewModel) {
  const latest = useRef(model);
  latest.current = model;
  const host = useRef<CameraPreviewHost | null>(null);
  const [status, setStatus] = useState<PreviewStatus>({ detached: false, opening: false });
  useEffect(() => {
    const owner = new CameraPreviewHost(latest.current, setStatus);
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

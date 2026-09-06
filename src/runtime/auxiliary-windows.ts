import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const AUXILIARY_CONTROLS_LABEL = "auxiliary-screen-sharing-controls";
export const AUXILIARY_STATE_EVENT = "auxiliary-window-state";
export const AUXILIARY_ACTION_EVENT = "auxiliary-window-action";

/** Both the native label and bundled route must match; an auxiliary view never mounts App. */
export function resolveWindowView(label: string, search: string) {
  if (label === "main") return "main";
  if (
    label === AUXILIARY_CONTROLS_LABEL &&
    new URLSearchParams(search).get("auxiliary") === "screen-sharing-controls"
  ) {
    return "screen-sharing-controls";
  }
  return null;
}

export interface ScreenSharingSnapshot {
  readonly revision: string;
  /** Changes with the main owner or marker setting, never with capture progress. */
  readonly pointerRevision: string;
  readonly available: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly pointersEnabled: boolean;
  readonly pointersReady: boolean;
  readonly sources: readonly { readonly id: number; readonly name: string }[];
  readonly sourceId: number | null;
  readonly intervalSeconds: number;
  readonly hasError: boolean;
  readonly lastObservedAt: number | null;
  readonly language: "en" | "ja";
}

export interface PublishedAuxiliarySnapshot {
  readonly version: number;
  readonly snapshot: ScreenSharingSnapshot;
}

export type ScreenSharingAuxiliaryAction =
  | { readonly type: "start" | "stop" | "refresh-sources" | "clear-annotations" | "retry-pointers" }
  | { readonly type: "select-source"; readonly sourceId: number }
  | { readonly type: "set-pointers-enabled"; readonly enabled: boolean }
  | { readonly type: "set-interval"; readonly intervalSeconds: number };

export interface RoutedAuxiliaryAction {
  readonly revision: string;
  readonly pointerRevision: string;
  readonly action: ScreenSharingAuxiliaryAction;
}

export function isPointerSettingsAction(action: ScreenSharingAuxiliaryAction): boolean {
  return action.type === "set-pointers-enabled" || action.type === "retry-pointers";
}

export interface ScreenSharingAuxiliaryModel {
  readonly ownerKey: string;
  readonly available: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly pointersEnabled: boolean;
  readonly pointersReady: boolean;
  readonly sources: readonly { readonly id: number; readonly name: string }[];
  readonly sourceId: number | null;
  readonly intervalSeconds: number;
  readonly error?: string;
  readonly lastObservedAt?: number;
  readonly language: string;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly refreshSources: () => Promise<void>;
  readonly clearAnnotations: () => Promise<void>;
  readonly retryPointers: () => Promise<void>;
  readonly setPointersEnabled: (enabled: boolean) => Promise<void>;
  readonly setSourceId: (id: number) => void;
  readonly setIntervalSeconds: (seconds: number) => void;
}

/** Copy known public fields only. In particular, errors may contain provider details. */
export function createScreenSharingSnapshot(
  model: ScreenSharingAuxiliaryModel,
  revision: string,
  pointerRevision = revision,
): ScreenSharingSnapshot {
  return {
    revision,
    pointerRevision,
    available: model.available,
    active: model.active,
    busy: model.busy,
    pointersEnabled: model.pointersEnabled,
    pointersReady: model.pointersReady,
    sources: model.sources.slice(0, 64).map(({ id, name }) => ({ id, name: name.slice(0, 200) })),
    sourceId: model.sourceId,
    intervalSeconds: model.intervalSeconds,
    hasError: Boolean(model.error),
    lastObservedAt: model.lastObservedAt ?? null,
    language: model.language.startsWith("ja") ? "ja" : "en",
  };
}

interface HostTransport {
  listenAction: (callback: (request: RoutedAuxiliaryAction) => void) => Promise<() => void>;
  publish: (snapshot: ScreenSharingSnapshot) => Promise<void>;
  open: () => Promise<void>;
  revision: () => string;
}

const nativeHostTransport: HostTransport = {
  listenAction: (callback) =>
    getCurrentWindow().listen<RoutedAuxiliaryAction>(AUXILIARY_ACTION_EVENT, (event) =>
      callback(event.payload),
    ),
  publish: (snapshot) => invoke("auxiliary_window_publish", { snapshot }),
  open: () => invoke("auxiliary_window_open", { kind: "screen-sharing-controls" }),
  revision: () => crypto.randomUUID(),
};

/** One main-window owner: no capture, session, or image delivery is performed by this bridge. */
export class ScreenSharingAuxiliaryHost {
  private model: ScreenSharingAuxiliaryModel | null = null;
  private snapshot: ScreenSharingSnapshot | null = null;
  private signature = "";
  private pointerSignature = "";
  private disposed = false;
  private unlisten: (() => void) | null = null;
  private publishQueue: Promise<void> = Promise.resolve();
  private publishError: unknown = null;
  private readonly ready: Promise<void>;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly transport: HostTransport = nativeHostTransport,
  ) {
    this.ready = transport
      .listenAction((request) => {
        void this.handleAction(request).catch(onError);
      })
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlisten = unlisten;
      });
    void this.ready.catch(onError);
  }

  update(model: ScreenSharingAuxiliaryModel): void {
    if (this.disposed) return;
    this.model = model;
    const safeFields = createScreenSharingSnapshot(model, "");
    // The owner affects revisions without revealing an agent or thread identifier to other views.
    const signature = JSON.stringify([model.ownerKey, safeFields]);
    if (signature === this.signature) return;
    this.signature = signature;
    const revision = this.transport.revision();
    const pointerSignature = JSON.stringify([
      model.ownerKey,
      model.pointersEnabled,
      model.pointersReady,
    ]);
    const pointerRevision =
      pointerSignature === this.pointerSignature && this.snapshot
        ? this.snapshot.pointerRevision
        : revision;
    this.pointerSignature = pointerSignature;
    const snapshot = { ...safeFields, revision, pointerRevision };
    this.snapshot = snapshot;
    this.publishQueue = this.publishQueue
      .then(async () => {
        if (this.disposed) return;
        await this.transport.publish(snapshot);
        this.publishError = null;
      })
      .catch((error: unknown) => {
        this.publishError = error;
        this.onError(error);
      });
  }

  async open(): Promise<void> {
    await this.ready;
    await this.publishQueue;
    if (this.disposed || !this.snapshot) return;
    if (this.publishError) throw this.publishError;
    await this.transport.open();
  }

  /** Check again in the owner: a newer React state may precede its native publication. */
  async handleAction(request: RoutedAuxiliaryAction): Promise<boolean> {
    const model = this.model;
    const snapshot = this.snapshot;
    if (this.disposed || !model || !snapshot) return false;
    const { action } = request;
    if (
      isPointerSettingsAction(action)
        ? request.pointerRevision !== snapshot.pointerRevision
        : request.revision !== snapshot.revision
    )
      return false;
    switch (action.type) {
      case "start":
        if (
          !model.available ||
          !model.pointersReady ||
          model.active ||
          model.busy ||
          !model.sources.some((source) => source.id === model.sourceId)
        )
          return false;
        await model.start();
        break;
      case "stop":
        model.stop();
        break;
      case "refresh-sources":
        if (model.active || model.busy) return false;
        await model.refreshSources();
        break;
      case "clear-annotations":
        await model.clearAnnotations();
        break;
      case "retry-pointers":
        if (model.pointersReady || !model.error) return false;
        await model.retryPointers();
        break;
      case "set-pointers-enabled":
        if (!model.pointersReady || typeof action.enabled !== "boolean") return false;
        await model.setPointersEnabled(action.enabled);
        break;
      case "select-source":
        if (
          model.active ||
          model.busy ||
          !model.sources.some((source) => source.id === action.sourceId)
        )
          return false;
        model.setSourceId(action.sourceId);
        break;
      case "set-interval":
        if (
          !Number.isInteger(action.intervalSeconds) ||
          action.intervalSeconds < 5 ||
          action.intervalSeconds > 60
        )
          return false;
        model.setIntervalSeconds(action.intervalSeconds);
        break;
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.model = null;
    this.snapshot = null;
    this.unlisten?.();
    this.unlisten = null;
  }
}

export function readAuxiliarySnapshot(): Promise<PublishedAuxiliarySnapshot | null> {
  return invoke("auxiliary_window_snapshot");
}

export function requestAuxiliaryAction(
  version: number,
  action: ScreenSharingAuxiliaryAction,
  pointerRevision?: string,
): Promise<void> {
  return invoke("auxiliary_window_request_action", {
    request: { version, action, ...(pointerRevision === undefined ? {} : { pointerRevision }) },
  });
}

export function listenAuxiliarySnapshot(
  callback: (snapshot: PublishedAuxiliarySnapshot) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<PublishedAuxiliarySnapshot>(AUXILIARY_STATE_EVENT, (event) =>
    callback(event.payload),
  );
}

/** A late initial read must not replace an event that already delivered newer state. */
export function latestAuxiliarySnapshot(
  current: PublishedAuxiliarySnapshot | null,
  incoming: PublishedAuxiliarySnapshot,
): PublishedAuxiliarySnapshot {
  return current && current.version > incoming.version ? current : incoming;
}

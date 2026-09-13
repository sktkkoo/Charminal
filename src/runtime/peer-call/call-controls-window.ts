import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

export const CALL_CONTROLS_LABEL = "auxiliary-call-controls";
export const CALL_CONTROLS_STATE = "call-controls-state";
export const CALL_CONTROLS_ACTION = "call-controls-action";
export const CALL_CONTROLS_CLOSED = "call-controls-closed";

/** Public pre-admission UI only: no avatar paths, media, persona, agent IDs or transcripts. */
export interface CallEntrySnapshot {
  ownerKey: string;
  enabled: boolean;
  language: "ja" | "en";
  name: string;
  localName: string;
  remoteName: string;
  active: boolean;
  connected: boolean;
  busy: string | null;
  status: string;
  error: string;
  notice: string;
  endpoint: string;
  signalState: string;
  role: string;
  invitation: string;
  guest: { name: string; requestId: string } | null;
  contacts?: { identityId: string; name: string; lastAcceptedAt: number }[];
  incoming?: { roomId: string; identityId: string; name: string; expiresAt: number } | null;
  presenceState?: "idle" | "connecting" | "online" | "offline" | "error";
  presenceError?: string;
  directTarget?: string;
  failedContactId?: string;
}
export interface PublishedCallControls {
  version: number;
  snapshot: CallEntrySnapshot & { revision: string };
}
export type CallControlsAction =
  | { type: "create"; name: string }
  | { type: "join"; name: string; invitation: string }
  | { type: "save-endpoint"; endpoint: string }
  | { type: "accept" | "decline"; requestId: string }
  | { type: "call-contact"; name: string; identityId: string }
  | { type: "answer-contact" | "decline-contact"; roomId: string }
  | { type: "remove-contact"; identityId: string }
  | { type: "cancel" | "hide" };
export interface RoutedCallControlsAction {
  revision: string;
  action: CallControlsAction;
}

export function callControlsActionAllowed(state: CallEntrySnapshot, action: CallControlsAction) {
  if (!state.enabled || state.connected) return false;
  if (action.type === "hide") return true;
  if (action.type === "cancel") return state.active;
  if (state.busy) return false;
  if (action.type === "accept" || action.type === "decline")
    return (
      state.active && state.signalState === "pending" && state.guest?.requestId === action.requestId
    );
  if (state.active) return false;
  if (action.type === "answer-contact" || action.type === "decline-contact")
    return (
      !!state.incoming &&
      state.incoming.roomId === action.roomId &&
      state.incoming.expiresAt > Date.now()
    );
  if (state.incoming) return false;
  if (action.type === "remove-contact")
    return (
      state.presenceState === "online" &&
      !!state.contacts?.some((contact) => contact.identityId === action.identityId)
    );
  if (action.type === "save-endpoint")
    return action.endpoint.trim().length > 0 && action.endpoint.length <= 2048;
  if (
    !state.endpoint ||
    !("name" in action) ||
    !action.name.trim() ||
    action.name.length > 64 ||
    Array.from(action.name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return false;
  return (
    (action.type === "call-contact" &&
      state.presenceState === "online" &&
      !!state.contacts?.some((contact) => contact.identityId === action.identityId)) ||
    action.type === "create" ||
    (action.type === "join" &&
      /^(?:yri1_[A-Za-z0-9_-]{22}|yri2_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{22})$/.test(
        action.invitation,
      ))
  );
}

export interface CallControlsPort {
  publish: (snapshot: PublishedCallControls["snapshot"]) => Promise<void>;
  open: () => Promise<void>;
  hide: () => Promise<void>;
  listen: (callback: (action: RoutedCallControlsAction) => void) => Promise<() => void>;
  listenClosed: (callback: () => void) => Promise<() => void>;
}
const nativePort: CallControlsPort = {
  publish: (snapshot) => invoke("call_controls_publish", { snapshot }),
  open: () => invoke("auxiliary_window_open", { kind: "call-controls" }),
  hide: () => invoke("call_controls_hide"),
  listen: (callback) =>
    getCurrentWindow().listen<RoutedCallControlsAction>(CALL_CONTROLS_ACTION, ({ payload }) =>
      callback(payload),
    ),
  listenClosed: (callback) => getCurrentWindow().listen(CALL_CONTROLS_CLOSED, callback),
};

// The native surface is shared across component lifetimes and Vite module replacement.
// Keep its queue/owner outside a particular hook or module instance. Test ports stay isolated.
type PresentationBroker = { owner: symbol | null; queue: Promise<void> };
const brokerKey = Symbol.for("yorishiro.call-controls-brokers");
const globals = globalThis as typeof globalThis & {
  [brokerKey]?: Map<CallControlsPort | "native", PresentationBroker>;
};
const brokers = globals[brokerKey] ?? new Map<CallControlsPort | "native", PresentationBroker>();
globals[brokerKey] = brokers;
function brokerFor(port: CallControlsPort) {
  const key = port === nativePort ? "native" : port;
  let broker = brokers.get(key);
  if (!broker) {
    broker = { owner: null, queue: Promise.resolve() };
    brokers.set(key, broker);
  }
  return broker;
}

/** Ordered presentation lifecycle. Hiding never invokes a room/media operation. */
export class CallControlsHost {
  private snapshot: PublishedCallControls["snapshot"] | null = null;
  private signature = "";
  private disposed = false;
  private broker: PresentationBroker;
  private owner = Symbol("call-controls-owner");
  private listeners: (() => void)[] = [];
  private ready: Promise<void>;
  private visible = false;
  private generation = 0;
  private consumed = "";
  private onAction: (action: CallControlsAction, ownerKey: string) => void = () => {};

  constructor(
    private onError: (error: unknown) => void,
    onClosed: () => void,
    private port = nativePort,
    private onSuccess: () => void = () => {},
  ) {
    this.broker = brokerFor(port);
    const previousOwner = this.broker.owner;
    this.broker.owner = this.owner;
    if (previousOwner)
      void this.enqueue(async () => {
        if (this.current()) await this.port.hide();
      }).catch(() => {});
    const keep = (dispose: () => void) => {
      if (this.disposed) dispose();
      else this.listeners.push(dispose);
    };
    this.ready = Promise.all([
      port
        .listen((event) => {
          const state = this.snapshot;
          if (
            !this.current() ||
            !state ||
            event.revision !== state.revision ||
            this.consumed === state.revision ||
            !callControlsActionAllowed(state, event.action)
          )
            return;
          // Native validates the published version; main also fences the current owner and repeats.
          this.consumed = state.revision;
          this.onAction(event.action, state.ownerKey);
        })
        .then(keep),
      port
        .listenClosed(() => {
          if (this.current()) {
            this.visible = false;
            onClosed();
          }
        })
        .then(keep),
    ])
      .then(() => {})
      .catch((error) => {
        if (this.current()) onError(error);
        this.dispose();
        throw error;
      });
    void this.ready.catch(() => {});
  }

  private current() {
    return !this.disposed && this.broker.owner === this.owner;
  }
  private enqueue(task: () => Promise<void>) {
    const result = this.broker.queue.catch(() => {}).then(task);
    this.broker.queue = result.catch(() => {});
    return result;
  }

  update(
    state: CallEntrySnapshot,
    onAction: (action: CallControlsAction, ownerKey: string) => void,
  ) {
    if (this.disposed) return;
    this.onAction = onAction;
    if (!state.enabled && !this.snapshot) return;
    const signature = JSON.stringify(state);
    if (signature !== this.signature || this.consumed === this.snapshot?.revision) {
      this.signature = signature;
      const snapshot = { ...state, revision: crypto.randomUUID() };
      this.snapshot = snapshot;
      void this.enqueue(async () => {
        if (this.current()) await this.port.publish(snapshot);
      }).catch((error) => {
        if (this.current()) this.onError(error);
      });
    }
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    const generation = ++this.generation;
    void this.enqueue(async () => {
      await this.ready;
      if (!this.current() || generation !== this.generation) return;
      if (visible) {
        if (!this.snapshot?.enabled || this.snapshot.connected) return;
        // Re-publish before opening; a failed initial publication must not show stale controls.
        await this.port.publish(this.snapshot);
        if (this.current() && generation === this.generation) {
          await this.port.open();
          if (this.current() && generation === this.generation) this.onSuccess();
        }
      } else await this.port.hide();
    }).catch((error) => {
      if (this.current()) this.onError(error);
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    for (const dispose of this.listeners) dispose();
    this.listeners = [];
    // Serialized after an in-flight open so an old completion cannot resurrect the surface.
    void this.enqueue(async () => {
      if (this.broker.owner === this.owner) await this.port.hide();
    }).catch(() => {});
  }
}

export function useCallControlsWindow(
  state: CallEntrySnapshot,
  onAction: (action: CallControlsAction, ownerKey: string) => void,
  onClosed: () => void,
) {
  const [error, setError] = useState("");
  const latest = useRef({ state, onAction, onClosed });
  latest.current = { state, onAction, onClosed };
  const host = useRef<CallControlsHost | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    const bridge = new CallControlsHost(
      (error) => setError(String(error)),
      () => latest.current.onClosed(),
      nativePort,
      () => setError(""),
    );
    host.current = bridge;
    bridge.update(latest.current.state, (action, ownerKey) =>
      latest.current.onAction(action, ownerKey),
    );
    bridge.setVisible(latest.current.state.enabled);
    return () => {
      if (host.current === bridge) host.current = null;
      bridge.dispose();
    };
  }, []);
  useEffect(() => {
    host.current?.update(state, (action, ownerKey) => latest.current.onAction(action, ownerKey));
    host.current?.setVisible(state.enabled);
  }, [state]);
  return {
    error,
    unsupported:
      /(?:command.*(?:not found|unknown)|unknown.*command|unknown field.*ownerKey|unknown variant.*call-controls)/i.test(
        error,
      ),
  };
}

export const readCallControls = () =>
  invoke<PublishedCallControls | null>("call_controls_snapshot");
export const requestCallControls = (version: number, action: CallControlsAction) =>
  invoke<void>("call_controls_request_action", { request: { version, action } });
export const listenCallControls = (callback: (value: PublishedCallControls) => void) =>
  getCurrentWindow().listen<PublishedCallControls>(CALL_CONTROLS_STATE, ({ payload }) =>
    callback(payload),
  );

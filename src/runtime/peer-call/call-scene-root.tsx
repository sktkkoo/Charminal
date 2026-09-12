import { Component as ReactComponent, type ReactNode, Suspense, useEffect, useMemo } from "react";
import type { Vector3 } from "three";
import { type ControlStore, ControlStoreProvider } from "../../sdk/controls";
import type { ScenePackCameraAPI } from "../../sdk/scene-pack";
import { AttentionLightCueStore } from "../attention-light-cue/cue-store";
import { SceneLevaStoreProvider, useCreateStore } from "../leva";
import { BUNDLED_ASSETS } from "../scene-pack-registry/asset-resolver";
import { makeResolveAsset } from "../scene-pack-registry/asset-resolver-pack";
import type { ScenePackEntry } from "../scene-pack-registry/types";
import { AttentionCueRuntimeProvider } from "../three-runtime/attention-cue-light";
import { AttentionLightSettingsStore } from "../three-runtime/attention-light-settings";

export interface CallSceneRootProps {
  readonly entry: ScenePackEntry;
  readonly controls: Record<string, unknown>;
  readonly getAnchor: () => Vector3 | null;
  readonly onError: (error: unknown) => void;
}

/** Main's final camera already includes scene modulation; never apply it twice. */
const copiedCamera: ScenePackCameraAPI = {
  addPositionModulation: () => ({ dispose() {} }),
  addFovModulation: () => ({ dispose() {} }),
  clearAll() {},
  isSuspended: true,
};

function isPlainControlValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainControlValue(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key !== "__proto__" &&
      key !== "constructor" &&
      key !== "prototype" &&
      isPlainControlValue(item, depth + 1),
  );
}

/** Applies only registered value inputs; snapshots cannot add controls or invoke buttons. */
export function applyCallSceneControls(store: ControlStore, values: Record<string, unknown>): void {
  const data = store.getData();
  const changes: Record<string, unknown> = Object.create(null);
  for (const [path, value] of Object.entries(values)) {
    const input = Object.getOwnPropertyDescriptor(data, path)?.value as
      | (typeof data)[string]
      | undefined;
    if (
      !input ||
      !("value" in input) ||
      input.__refCount === 0 ||
      !isPlainControlValue(value) ||
      JSON.stringify(input.value) === JSON.stringify(value)
    ) {
      continue;
    }
    changes[path] = structuredClone(value);
  }
  if (Object.keys(changes).length > 0) store.set(changes, false);
}

const componentIds = new WeakMap<NonNullable<ScenePackEntry["component"]>, number>();
let nextComponentId = 0;

export function CallSceneRoot(props: CallSceneRootProps) {
  // Discard the old schema on same-id component reload, but preserve the store for layer updates.
  const component = props.entry.component;
  let componentId = component ? componentIds.get(component) : 0;
  if (component && componentId === undefined) {
    componentId = ++nextComponentId;
    componentIds.set(component, componentId);
  }
  return (
    <CallSceneInstance key={`${props.entry.origin}:${props.entry.id}:${componentId}`} {...props} />
  );
}

function CallSceneInstance({ entry, controls, getAnchor, onError }: CallSceneRootProps) {
  const store = useCreateStore();
  const resolveAsset = useMemo(
    () =>
      entry.resolveAsset ??
      makeResolveAsset({ packId: entry.id, origin: entry.origin, bundledAssets: BUNDLED_ASSETS }),
    [entry.id, entry.origin, entry.resolveAsset],
  );
  const cueStore = useMemo(
    () => new AttentionLightCueStore({ settings: new AttentionLightSettingsStore() }),
    [],
  );
  const attentionRuntime = useMemo(() => ({ cueStore, getAnchor }), [cueStore, getAnchor]);

  useEffect(() => {
    let applying = false;
    let active = true;
    let queued = false;
    const apply = () => {
      if (applying) return;
      applying = true;
      try {
        applyCallSceneControls(store, controls);
      } catch (error) {
        onError(error);
      } finally {
        applying = false;
      }
    };
    // Suspended components can register their inputs after this effect. Observe that registration
    // as well as later owner snapshots, rather than losing values during the first asset load.
    const unsubscribe = store.useStore.subscribe(
      // Leva mutates data in place when adding paths, but replaces the outer state.
      (state) => state,
      () => {
        if (queued || applying) return;
        queued = true;
        // Let the registration notification finish before setting values: a nested store.set
        // would otherwise let later subscribers overwrite the mirrored value with old defaults.
        queueMicrotask(() => {
          queued = false;
          if (active) apply();
        });
      },
    );
    apply();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [store, controls, onError]);

  useEffect(() => () => store.dispose(), [store]);

  const Component = entry.component;
  return (
    <AttentionCueRuntimeProvider value={attentionRuntime}>
      <SceneLevaStoreProvider store={store}>
        <ControlStoreProvider store={store}>
          <CallSceneErrorBoundary component={Component} onError={onError}>
            <Suspense fallback={null}>
              {Component ? (
                <Component vrmSlot={null} resolveAsset={resolveAsset} camera={copiedCamera} />
              ) : null}
            </Suspense>
          </CallSceneErrorBoundary>
        </ControlStoreProvider>
      </SceneLevaStoreProvider>
    </AttentionCueRuntimeProvider>
  );
}

interface BoundaryProps {
  readonly component: ScenePackEntry["component"];
  readonly onError: (error: unknown) => void;
  readonly children: ReactNode;
}

class CallSceneErrorBoundary extends ReactComponent<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  componentDidUpdate(previous: BoundaryProps): void {
    if (previous.component !== this.props.component && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

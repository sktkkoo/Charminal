import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { MOUTH_KEYS, type MouthValues } from "../../core/voice/mouth-values";
import { PreviewHost, type PreviewStatus, type PreviewTransport } from "../preview-host";
import { getVrmCache } from "../vrm-cache";
import { type AvatarMotionPose, encodeAvatarMotion } from "./avatar-motion";
import { validateAvatarGlb } from "./avatar-transfer";
import { publishCallScene, releaseCallScenePublisher } from "./call-scene-media";
import type { CallSceneAppearance } from "./call-scene-state";

export const REMOTE_CALL_WINDOW_LABEL = "auxiliary-call-resident";
export const REMOTE_CALL_WINDOW_EVENT = "remote-call-window-state";
export interface RemoteCallCamera {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
  zoom?: number;
  near: number;
  far: number;
  /** Main's current world-space head anchor; preserve its camera-to-resident framing. */
  anchor?: [number, number, number];
  /** Compatibility with frames that published only the local head height. */
  anchorY: number;
}
export interface RemoteCallWindowFrame {
  leaseId: string;
  label: string;
  language: "ja" | "en";
  mode: "call" | "portrait";
  /** Hide and pause the presentation while retaining its current assets and native lease. */
  visible?: boolean;
  motion: number[] | null;
  mouth: [number, number, number, number, number];
  camera: RemoteCallCamera;
  sequence?: number;
  avatarRevision?: number;
  sceneRevision?: number;
}
export interface RemoteCallWindowModel {
  /** Stable across view modes for an admitted remote participant. Null releases its presentation. */
  ownerKey: string | null;
  visible: boolean;
  label: string;
  language: string;
  mode: "call" | "portrait";
  avatarUrl: string | null;
  sampleMotion(): AvatarMotionPose | null;
  sampleMouth(): Readonly<MouthValues> | number;
  sampleCamera(): RemoteCallCamera;
  /** Selected scene and controls from this main window, never received from the call peer. */
  sampleScene?(): CallSceneAppearance;
}

interface Transport extends PreviewTransport<RemoteCallWindowFrame> {
  avatar(leaseId: string, bytes: ArrayBuffer): Promise<void>;
  scene(leaseId: string, scene: CallSceneAppearance): Promise<number>;
}
function base64(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 16_384) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}
const nativeTransport: Transport = {
  begin: () => invoke("remote_call_window_begin"),
  open: (leaseId) => invoke("remote_call_window_open", { leaseId }),
  show: (leaseId) => invoke("remote_call_window_show", { leaseId }),
  revoke: (leaseId) => {
    releaseCallScenePublisher(leaseId);
    return invoke("remote_call_window_revoke", { leaseId });
  },
  publish: (frame) => invoke("remote_call_window_publish", { frame }),
  avatar: (leaseId, bytes) =>
    invoke("remote_call_window_avatar", { leaseId, encoded: base64(bytes) }),
  scene: publishCallScene,
  listen: (callback) =>
    getCurrentWindow().listen<{ leaseId: string; action: "attach" }>(
      "remote-call-window-action",
      (event) => callback(event.payload),
    ),
};

/** Sample the main-owned received pose/audio analysis; never acquire audio or create an agent here. */
export function startRemoteCallRelay(
  model: () => RemoteCallWindowModel,
  leaseId: string,
  publish: (frame: RemoteCallWindowFrame) => Promise<void>,
  upload: (leaseId: string, bytes: ArrayBuffer) => Promise<void>,
  fail: (error: unknown) => void,
  getBytes: (url: string) => Promise<ArrayBuffer> = (url) => getVrmCache().getBytes(url),
  uploadScene?: (leaseId: string, scene: CallSceneAppearance) => Promise<number>,
): () => void {
  let stopped = false;
  let pending = false;
  let sequence = 0;
  let uploaded: string | null = null;
  let uploading: string | null = null;
  let failedAvatar: string | null = null;
  let scenePending = false;
  let sceneKey: string | undefined;
  let publishedVisibility: boolean | undefined;
  const sampleScene = () => {
    if (stopped || scenePending || !uploadScene || !model().visible) return;
    try {
      const appearance = model().sampleScene?.();
      if (!appearance) return;
      const key = JSON.stringify(appearance);
      if (key === sceneKey) return;
      scenePending = true;
      void uploadScene(leaseId, appearance)
        .then(() => {
          if (!stopped) sceneKey = key;
        })
        .catch((error: unknown) => {
          if (!stopped) fail(error);
        })
        .finally(() => {
          scenePending = false;
        });
    } catch (error) {
      if (!stopped) fail(error);
    }
  };
  const sample = () => {
    if (stopped || pending) return;
    const source = model();
    // One hidden frame pauses the existing native view. Keep the loaded asset keys, but
    // sample neither motion nor asset/settings updates while that presentation is unused.
    if (!source.visible && publishedVisibility === false) return;
    const avatarUrl = source.avatarUrl;
    if (
      source.visible &&
      avatarUrl &&
      avatarUrl !== uploaded &&
      avatarUrl !== uploading &&
      avatarUrl !== failedAvatar
    ) {
      uploading = avatarUrl;
      void getBytes(avatarUrl)
        .then(async (bytes) => {
          if (stopped || model().avatarUrl !== avatarUrl) return;
          if (!validateAvatarGlb(bytes))
            throw new Error("The received avatar is not a self-contained VRM.");
          await upload(leaseId, bytes);
          if (!stopped && model().avatarUrl === avatarUrl) uploaded = avatarUrl;
        })
        .catch((error: unknown) => {
          if (!stopped && model().avatarUrl === avatarUrl) {
            failedAvatar = avatarUrl;
            fail(error);
          }
        })
        .finally(() => {
          if (uploading === avatarUrl) uploading = null;
        });
    }
    try {
      const pose = source.visible ? source.sampleMotion() : null;
      const mouth = source.visible ? source.sampleMouth() : 0;
      const unit = (value: number) =>
        Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      const weights = MOUTH_KEYS.map((key) =>
        unit(typeof mouth === "number" ? (key === "aa" ? mouth : 0) : mouth[key]),
      );
      const frame: RemoteCallWindowFrame = {
        leaseId,
        label: source.label.slice(0, 80),
        language: source.language.startsWith("ja") ? "ja" : "en",
        mode: source.mode,
        visible: source.visible,
        motion: pose
          ? Array.from(
              new Uint8Array(
                encodeAvatarMotion({
                  sequence: sequence++ >>> 0,
                  timestampMs: performance.now(),
                  pose,
                }),
              ),
            )
          : null,
        mouth: weights as RemoteCallWindowFrame["mouth"],
        camera: source.sampleCamera(),
      };
      pending = true;
      void publish(frame)
        .then(() => {
          if (!stopped) publishedVisibility = frame.visible;
        })
        .catch((error: unknown) => {
          if (!stopped) fail(error);
        })
        .finally(() => {
          pending = false;
        });
    } catch (error) {
      fail(error);
    }
  };
  const timer = setInterval(sample, 33);
  const sceneTimer = setInterval(sampleScene, 100);
  sampleScene();
  sample();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(sceneTimer);
  };
}

type HostModel = RemoteCallWindowModel & {
  initiallyDetached: true;
  /** PreviewHost visibility owns resource creation; this flag owns the retained window's display. */
  presentationVisible: boolean;
  onStop(): void;
};
const lifecycle = { pending: Promise.resolve() };
export class RemoteCallWindowHost extends PreviewHost<HostModel, string, RemoteCallWindowFrame> {
  private retainedOwner: string | null;
  constructor(
    model: RemoteCallWindowModel,
    changed: (status: PreviewStatus) => void,
    transport: Transport = nativeTransport,
  ) {
    super(
      { ...model, presentationVisible: model.visible, initiallyDetached: true, onStop() {} },
      changed,
      transport,
      {
        source: (current) => current.ownerKey,
        ready: () => true,
        relay: (_source, latest, leaseId, publish, fail) =>
          startRemoteCallRelay(
            () => {
              const current = latest();
              return { ...current, visible: current.presentationVisible };
            },
            leaseId,
            publish,
            transport.avatar,
            fail,
            undefined,
            transport.scene,
          ),
      },
      lifecycle,
    );
    this.retainedOwner = model.visible ? model.ownerKey : null;
  }
  updateModel(model: RemoteCallWindowModel): void {
    if (this.retainedOwner !== model.ownerKey) this.retainedOwner = null;
    if (model.visible) this.retainedOwner = model.ownerKey;
    this.update({
      ...model,
      // Lazily open only when first requested, then keep that same webview/lease until
      // the participant changes or disconnects. Mode switches only hide/show its frames.
      visible: !!model.ownerKey && this.retainedOwner === model.ownerKey,
      presentationVisible: model.visible,
      initiallyDetached: true,
      onStop() {},
    });
  }
}

export function useRemoteCallWindow(model: RemoteCallWindowModel) {
  const latest = useRef(model);
  latest.current = model;
  const host = useRef<RemoteCallWindowHost | null>(null);
  const [status, setStatus] = useState<PreviewStatus>({ detached: false, opening: false });
  useEffect(() => {
    const owner = new RemoteCallWindowHost(latest.current, setStatus);
    host.current = owner;
    owner.updateModel(latest.current);
    return () => {
      if (host.current === owner) host.current = null;
      owner.dispose();
    };
  }, []);
  useEffect(() => {
    host.current?.updateModel(model);
  }, [model]);
  const show = useCallback(() => host.current?.detach(), []);
  return { ...status, show };
}

export function listenRemoteCallWindow(
  callback: (frame: RemoteCallWindowFrame) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<RemoteCallWindowFrame>(REMOTE_CALL_WINDOW_EVENT, (event) =>
    callback(event.payload),
  );
}
export function readRemoteCallWindow(): Promise<RemoteCallWindowFrame | null> {
  return invoke("remote_call_window_snapshot");
}
export function readRemoteCallAvatar(leaseId: string, revision: number): Promise<ArrayBuffer> {
  return invoke("remote_call_window_read_avatar", { leaseId, revision });
}
export function readRemoteCallScene(
  leaseId: string,
  revision: number,
): Promise<CallSceneAppearance | null> {
  return invoke("remote_call_window_read_scene", { leaseId, revision });
}
export function hideRemoteCallWindow(leaseId: string): Promise<void> {
  return invoke("remote_call_window_hide", { leaseId });
}

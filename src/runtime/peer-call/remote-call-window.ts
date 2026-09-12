import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { MOUTH_KEYS, type MouthValues } from "../../core/voice/mouth-values";
import { PreviewHost, type PreviewStatus, type PreviewTransport } from "../preview-host";
import { getVrmCache } from "../vrm-cache";
import { type AvatarMotionPose, encodeAvatarMotion } from "./avatar-motion";
import { validateAvatarGlb } from "./avatar-transfer";

export const REMOTE_CALL_WINDOW_LABEL = "auxiliary-call-resident";
export const REMOTE_CALL_WINDOW_EVENT = "remote-call-window-state";
export interface RemoteCallCamera {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
  zoom?: number;
  near: number;
  far: number;
  /** The local head anchor; adapt only stature, preserving the existing view's camera settings. */
  anchorY: number;
}
export interface RemoteCallWindowFrame {
  leaseId: string;
  label: string;
  language: "ja" | "en";
  mode: "call" | "portrait";
  motion: number[] | null;
  mouth: [number, number, number, number, number];
  camera: RemoteCallCamera;
  sequence?: number;
  avatarRevision?: number;
}
export interface RemoteCallWindowModel {
  /** Stable for an admitted remote participant. Null closes only the presentation. */
  ownerKey: string | null;
  visible: boolean;
  label: string;
  language: string;
  mode: "call" | "portrait";
  avatarUrl: string | null;
  sampleMotion(): AvatarMotionPose | null;
  sampleMouth(): Readonly<MouthValues> | number;
  sampleCamera(): RemoteCallCamera;
}

interface Transport extends PreviewTransport<RemoteCallWindowFrame> {
  avatar(leaseId: string, bytes: ArrayBuffer): Promise<void>;
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
  revoke: (leaseId) => invoke("remote_call_window_revoke", { leaseId }),
  publish: (frame) => invoke("remote_call_window_publish", { frame }),
  avatar: (leaseId, bytes) =>
    invoke("remote_call_window_avatar", { leaseId, encoded: base64(bytes) }),
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
): () => void {
  let stopped = false;
  let pending = false;
  let sequence = 0;
  let uploaded: string | null = null;
  let uploading: string | null = null;
  let failedAvatar: string | null = null;
  const sample = () => {
    if (stopped || pending) return;
    const source = model();
    const avatarUrl = source.avatarUrl;
    if (
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
      const pose = source.sampleMotion();
      const mouth = source.sampleMouth();
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
  sample();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

type HostModel = RemoteCallWindowModel & { initiallyDetached: true; onStop(): void };
const lifecycle = { pending: Promise.resolve() };
export class RemoteCallWindowHost extends PreviewHost<HostModel, string, RemoteCallWindowFrame> {
  constructor(
    model: RemoteCallWindowModel,
    changed: (status: PreviewStatus) => void,
    transport: Transport = nativeTransport,
  ) {
    super(
      { ...model, initiallyDetached: true, onStop() {} },
      changed,
      transport,
      {
        source: (current) => current.ownerKey,
        ready: () => true,
        relay: (_source, latest, leaseId, publish, fail) =>
          startRemoteCallRelay(latest, leaseId, publish, transport.avatar, fail),
      },
      lifecycle,
    );
  }
  updateModel(model: RemoteCallWindowModel): void {
    this.update({ ...model, initiallyDetached: true, onStop() {} });
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
export function hideRemoteCallWindow(leaseId: string): Promise<void> {
  return invoke("remote_call_window_hide", { leaseId });
}

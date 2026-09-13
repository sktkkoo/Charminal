import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { MOUTH_KEYS, type MouthValues, ZERO_MOUTH } from "./core/voice/mouth-values";
import { AvatarMotionBuffer, decodeAvatarMotion } from "./runtime/peer-call/avatar-motion";
import { validateAvatarGlb } from "./runtime/peer-call/avatar-transfer";
import { NativeCallAvatar } from "./runtime/peer-call/call-avatar";
import { loadCallScene } from "./runtime/peer-call/call-scene-loader";
import {
  type CallSceneMediaReceiver,
  createCallSceneMediaReceiver,
} from "./runtime/peer-call/call-scene-media";
import type { CallSceneAppearance } from "./runtime/peer-call/call-scene-state";
import {
  hideRemoteCallWindow,
  listenRemoteCallWindow,
  type RemoteCallWindowFrame,
  readRemoteCallAvatar,
  readRemoteCallScene,
  readRemoteCallWindow,
} from "./runtime/peer-call/remote-call-window";
import type { ScenePackEntry } from "./runtime/scene-pack-registry";
import { shouldStartViewModeWindowDrag } from "./runtime/view-mode-window-interaction";
import "./auxiliary-call-resident.css";

/** A second native resident view only. No App, room, audio output, microphone, or provider session. */
export default function AuxiliaryCallResident() {
  const [frame, setFrame] = useState<RemoteCallWindowFrame | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarBytes, setAvatarBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState("");
  const [appearance, setAppearance] = useState<CallSceneAppearance | null>(null);
  const [sceneEntry, setSceneEntry] = useState<ScenePackEntry | null>(null);
  const [sceneReadError, setSceneReadError] = useState("");
  const [sceneLoadError, setSceneLoadError] = useState("");
  const appearanceContext = useRef({ leaseId: "", sceneRevision: 0 });
  const loadedSceneKey = useRef("");
  const sceneMedia = useRef<CallSceneMediaReceiver | null>(null);
  const latest = useRef<RemoteCallWindowFrame | null>(null);
  const motion = useRef(new AvatarMotionBuffer(35));
  const lastArrival = useRef(0);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let eventRevision = 0;
    const receive = (next: RemoteCallWindowFrame | null) => {
      if (disposed || !next) return;
      const previous = latest.current;
      if (previous && (next.sequence ?? 0) <= (previous.sequence ?? 0)) return;
      if (previous?.leaseId !== next.leaseId) motion.current.reset();
      latest.current = next;
      lastArrival.current = performance.now();
      if (next.motion) {
        const decoded = decodeAvatarMotion(new Uint8Array(next.motion).buffer);
        if (decoded) motion.current.push(decoded, lastArrival.current);
      } else motion.current.reset();
      // Camera, mouth, and motion update via refs. React only renders metadata changes.
      setFrame((current) =>
        current?.leaseId === next.leaseId &&
        current.avatarRevision === next.avatarRevision &&
        current.sceneRevision === next.sceneRevision &&
        current.label === next.label &&
        current.mode === next.mode &&
        current.visible === next.visible &&
        current.language === next.language
          ? current
          : next,
      );
    };
    void listenRemoteCallWindow((next) => {
      eventRevision++;
      receive(next);
    })
      .then(async (cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const beforeRead = eventRevision;
        const snapshot = await readRemoteCallWindow();
        if (beforeRead === eventRevision) receive(snapshot);
      })
      .catch(() => {
        if (!disposed) setError("通話の表示に接続できませんでした。");
      });
    return () => {
      disposed = true;
      unlisten?.();
      motion.current.reset();
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    let ownedUrl: string | null = null;
    setAvatarUrl(null);
    setAvatarBytes(null);
    if (frame?.avatarRevision) {
      void readRemoteCallAvatar(frame.leaseId, frame.avatarRevision)
        .then((bytes) => {
          if (disposed) return;
          if (!validateAvatarGlb(bytes)) throw new Error("Invalid remote avatar");
          ownedUrl = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
          setAvatarUrl(ownedUrl);
          setAvatarBytes(bytes);
          setError("");
        })
        .catch(() => {
          if (!disposed) setError("相手の姿を表示できませんでした。");
        });
    }
    return () => {
      disposed = true;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [frame?.leaseId, frame?.avatarRevision]);
  useEffect(() => {
    const receiver = frame?.leaseId ? createCallSceneMediaReceiver(frame.leaseId) : null;
    sceneMedia.current = receiver;
    return () => {
      receiver?.dispose();
      if (sceneMedia.current === receiver) sceneMedia.current = null;
    };
  }, [frame?.leaseId]);
  useEffect(() => {
    let disposed = false;
    if (!frame?.sceneRevision) {
      setAppearance(null);
      setSceneReadError("");
      return;
    }
    const receiver = sceneMedia.current;
    void readRemoteCallScene(frame.leaseId, frame.sceneRevision)
      .then((next) => (next && receiver ? receiver.project(next) : next))
      .then((next) => {
        if (!disposed && next) {
          appearanceContext.current = {
            leaseId: frame.leaseId,
            sceneRevision: frame.sceneRevision ?? 0,
          };
          setAppearance(next);
          setSceneReadError("");
        }
      })
      .catch(() => {
        if (!disposed) setSceneReadError("シーンの設定を取得できませんでした。");
      });
    return () => {
      disposed = true;
    };
  }, [frame?.leaseId, frame?.sceneRevision]);
  const sceneSource = JSON.stringify(appearance?.source ?? null);
  const sceneLease = appearanceContext.current.leaseId;
  useEffect(() => {
    if (sceneSource === "null") {
      loadedSceneKey.current = "";
      setSceneEntry(null);
      setSceneLoadError("");
      return;
    }
    const key = `${frame?.leaseId}:${sceneSource}`;
    if (loadedSceneKey.current === key) return;
    let disposed = false;
    setSceneEntry(null);
    setSceneLoadError("");
    if (sceneLease === frame?.leaseId) {
      void loadCallScene(JSON.parse(sceneSource), appearanceContext.current)
        .then((entry) => {
          if (!disposed) {
            loadedSceneKey.current = key;
            setSceneEntry(entry);
          }
        })
        .catch(() => {
          if (!disposed) setSceneLoadError("シーンを読み込めませんでした。");
        });
    }
    return () => {
      disposed = true;
    };
  }, [sceneSource, sceneLease, frame?.leaseId]);
  const japanese = (frame?.language ?? navigator.language).startsWith("ja");
  return (
    <main
      className={`remote-call-resident remote-call-resident-${frame?.mode ?? "portrait"}`}
      style={{ background: appearance?.background ?? "#141619" }}
      onPointerDown={(event) => {
        if (!shouldStartViewModeWindowDrag(true, event.button, event.target)) return;
        event.preventDefault();
        void getCurrentWindow()
          .startDragging()
          .catch(() => undefined);
      }}
    >
      {avatarUrl ? (
        <NativeCallAvatar
          avatarUrl={avatarUrl}
          avatarBytes={avatarBytes ?? undefined}
          label={frame?.label ?? ""}
          className="remote-call-resident-avatar"
          active={frame?.visible !== false}
          sampleMotion={() => motion.current.sample(performance.now())}
          sampleMouth={() => {
            const weights = latest.current?.mouth;
            if (!weights || performance.now() - lastArrival.current > 250) return ZERO_MOUTH;
            return Object.fromEntries(
              MOUTH_KEYS.map((key, index) => [key, weights[index]]),
            ) as unknown as MouthValues;
          }}
          sampleCamera={() => latest.current?.camera ?? null}
          sceneEntry={sceneEntry}
          appearance={appearance}
        />
      ) : (
        <div className="remote-call-resident-waiting" role="status">
          {error || (japanese ? "相手の姿を待っています…" : "Waiting for the resident…")}
        </div>
      )}
      {sceneLoadError || sceneReadError ? (
        <div className="remote-call-resident-waiting" role="alert">
          {sceneLoadError || sceneReadError}
        </div>
      ) : null}
      <div className="remote-call-resident-chrome">
        <button
          type="button"
          className="remote-call-resident-name"
          aria-label={
            japanese
              ? `${frame?.label ?? "Yorishiro"}・通話相手 — ウィンドウを移動`
              : `${frame?.label ?? "Yorishiro"}, call participant — Move window`
          }
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void getCurrentWindow()
              .startDragging()
              .catch(() => undefined);
          }}
        >
          <span className="remote-call-resident-dot" aria-hidden="true">
            ●
          </span>
          <span className="remote-call-resident-identity">
            <strong title={frame?.label ?? "Yorishiro"}>{frame?.label ?? "Yorishiro"}</strong>
            <small>{japanese ? "通話相手" : "Call participant"}</small>
          </span>
        </button>
        <button
          type="button"
          className="remote-call-resident-hide"
          aria-label={japanese ? "相手のウィンドウを隠す" : "Hide resident window"}
          onClick={() => {
            if (frame) void hideRemoteCallWindow(frame.leaseId);
          }}
        >
          ×
        </button>
      </div>
    </main>
  );
}

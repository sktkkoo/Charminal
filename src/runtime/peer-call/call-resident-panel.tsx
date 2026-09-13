import { useCallback, useEffect, useRef, useState } from "react";
import type { ScenePackEntry } from "../scene-pack-registry";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import { NativeCallAvatar } from "./call-avatar";
import { type CallSceneAppearance, sampleCallScene } from "./call-scene-state";
import type { RemoteCallCamera } from "./remote-call-window";
import type { RoomCall } from "./room-call";
import "./call-resident-panel.css";

interface CallResidentPanelProps {
  room: RoomCall;
  sceneEntry: ScenePackEntry | null;
  language: string;
  active?: boolean;
}

/** The terminal's second resident. Presentation never creates a room, window, or audio session. */
export function CallResidentPanel({
  room,
  sceneEntry,
  language,
  active = true,
}: CallResidentPanelProps) {
  const currentRoom = useRef(room);
  currentRoom.current = room;
  const [retainedRoom, setRetainedRoom] = useState<RoomCall | null>(active ? room : null);
  useEffect(() => {
    if (active) setRetainedRoom(room);
  }, [active, room]);
  const mounted = active || retainedRoom === room;
  const [appearance, setAppearance] = useState<CallSceneAppearance | null>(null);
  const encodedAppearance = useRef("");
  // A source change is sampled immediately; mutable main-scene controls are sampled quietly.
  // Keep the avatar mounted while SceneRouter replaces the scene's DOM character slot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new loaded entry needs an immediate snapshot of main's selected scene.
  useEffect(() => {
    if (!active) return;
    const sync = () => {
      const next = sampleCallScene();
      const encoded = JSON.stringify(next);
      if (encoded === encodedAppearance.current) return;
      encodedAppearance.current = encoded;
      setAppearance(next);
    };
    sync();
    const timer = window.setInterval(sync, 100);
    return () => window.clearInterval(timer);
  }, [sceneEntry, active]);
  const sampleMotion = useCallback(
    () => currentRoom.current.peer?.motion.sample(performance.now()) ?? null,
    [],
  );
  const sampleMouth = useCallback(
    () => currentRoom.current.peer?.audio.sampleRemoteMouth() ?? 0,
    [],
  );
  const sampleCamera = useCallback((): RemoteCallCamera => {
    const runtime = getThreeRuntime();
    const camera = runtime.getCamera();
    const anchor = runtime.getCharacterAnchor();
    return {
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      fov: camera.fov,
      zoom: camera.zoom,
      near: camera.near,
      far: camera.far,
      anchorY: anchor?.y ?? 1.5,
      ...(anchor ? { anchor: [anchor.x, anchor.y, anchor.z] as [number, number, number] } : {}),
    };
  }, []);
  const japanese = language.startsWith("ja");
  const label = room.signaling.remoteName || (japanese ? "通話相手" : "Call participant");
  const status = room.paused
    ? japanese
      ? "AIの会話は停止中"
      : "AI conversation stopped"
    : room.ready
      ? japanese
        ? "通話中"
        : "In call"
      : japanese
        ? "AIに接続中"
        : "Connecting AI";
  return (
    <aside
      className="call-resident-panel"
      hidden={!active}
      aria-label={japanese ? `${label}・通話相手` : `${label}, call participant`}
      style={{ background: appearance?.background }}
    >
      <header className="call-resident-panel-header">
        <span className="call-resident-panel-dot" aria-hidden="true">
          ●
        </span>
        <div className="call-resident-panel-identity">
          <strong title={label}>{label}</strong>
          <small>{status}</small>
        </div>
      </header>
      <div className="call-resident-panel-content">
        {mounted && room.remoteAvatarUrl ? (
          <NativeCallAvatar
            avatarUrl={room.remoteAvatarUrl}
            label={label}
            className="call-resident-panel-avatar"
            sampleMotion={sampleMotion}
            sampleMouth={sampleMouth}
            sampleCamera={sampleCamera}
            sceneEntry={sceneEntry}
            appearance={appearance}
            active={active}
          />
        ) : (
          <p className="call-resident-panel-waiting" role="status">
            {japanese ? "相手の姿を待っています…" : "Waiting for the resident…"}
          </p>
        )}
      </div>
    </aside>
  );
}

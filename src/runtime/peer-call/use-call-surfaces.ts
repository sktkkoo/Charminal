import { useEffect, useState } from "react";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import { useRemoteCallWindow } from "./remote-call-window";
import type { RoomCall } from "./room-call";
import { attachTheaterCallPeer } from "./theater-call-peer";

/** Presentation follows the existing view; connecting never selects a view or camera preset. */
export function useCallSurfaces(room: RoomCall | null, viewMode: string | null, language: string) {
  const connected = !!room?.connected;
  const theater = viewMode === "theater";
  const avatarUrl = connected ? room.remoteAvatarUrl : null;
  const [theaterError, setTheaterError] = useState<string>();
  useEffect(() => {
    setTheaterError(undefined);
    if (!connected || !theater || !avatarUrl || !room) return;
    const handle = attachTheaterCallPeer({
      avatarUrl,
      sampleMotion: () => room.peer?.motion.sample(performance.now()) ?? null,
      sampleMouth: () => room.peer?.audio.sampleRemoteMouth() ?? 0,
      onState: (state, message) => setTheaterError(state === "error" ? message : undefined),
    });
    return () => handle.dispose();
  }, [connected, theater, avatarUrl, room]);
  const remoteWindow = useRemoteCallWindow({
    ownerKey: connected ? `${room.signaling.roomId}:${room.signaling.remoteEndpointId}` : null,
    visible: connected && !theater,
    label: room?.signaling.remoteName || "",
    language,
    mode: viewMode === "companion" ? "portrait" : "call",
    avatarUrl,
    sampleMotion: () => room?.peer?.motion.sample(performance.now()) ?? null,
    sampleMouth: () => room?.peer?.audio.sampleRemoteMouth() ?? 0,
    sampleCamera: () => {
      const runtime = getThreeRuntime();
      const camera = runtime.getCamera();
      return {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        fov: camera.fov,
        zoom: camera.zoom,
        near: camera.near,
        far: camera.far,
        anchorY: runtime.getCharacterAnchor()?.y ?? 1.5,
      };
    },
  });
  return { show: remoteWindow.show, error: theater ? theaterError : remoteWindow.error };
}

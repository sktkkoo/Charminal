import { useEffect, useRef, useState } from "react";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import { sampleCallScene } from "./call-scene-state";
import { useRemoteCallWindow } from "./remote-call-window";
import type { RoomCall } from "./room-call";
import { attachTheaterCallPeer, type TheaterCallPeerHandle } from "./theater-call-peer";

/** Presentation follows the existing view; connecting never selects a view or camera preset. */
export function useCallSurfaces(room: RoomCall | null, viewMode: string | null, language: string) {
  const connected = !!room?.connected;
  const theater = viewMode === "theater" || viewMode === "immersive";
  const detached = viewMode === "portrait" || viewMode === "companion";
  const avatarUrl = connected ? room.remoteAvatarUrl : null;
  const [theaterError, setTheaterError] = useState<string>();
  const theaterHandle = useRef<TheaterCallPeerHandle | null>(null);
  // A loaded theater resident belongs to the call/avatar, not the selected view.
  // Its inactive handle releases scene placement and frame work without disposing VRM assets.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a changed owner/avatar or disconnection invalidates these loaded assets.
  useEffect(() => {
    setTheaterError(undefined);
    return () => {
      theaterHandle.current?.dispose();
      theaterHandle.current = null;
    };
  }, [connected, avatarUrl, room]);
  useEffect(() => {
    if (!connected || !avatarUrl || !room) return;
    if (theater && !theaterHandle.current) {
      theaterHandle.current = attachTheaterCallPeer({
        avatarUrl,
        sampleMotion: () => room.peer?.motion.sample(performance.now()) ?? null,
        sampleMouth: () => room.peer?.audio.sampleRemoteMouth() ?? 0,
        onState: (state, message) => {
          if (state === "error") theaterHandle.current = null;
          setTheaterError(state === "error" ? message : undefined);
        },
      });
    }
    theaterHandle.current?.setActive(theater);
  }, [connected, theater, avatarUrl, room]);
  const remoteWindow = useRemoteCallWindow({
    ownerKey: connected ? `${room.signaling.roomId}:${room.signaling.remoteEndpointId}` : null,
    visible: connected && detached,
    label: room?.signaling.remoteName || "",
    language,
    mode: viewMode === "companion" ? "portrait" : "call",
    avatarUrl,
    sampleMotion: () => room?.peer?.motion.sample(performance.now()) ?? null,
    sampleMouth: () => room?.peer?.audio.sampleRemoteMouth() ?? 0,
    sampleScene: sampleCallScene,
    sampleCamera: () => {
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
    },
  });
  return {
    inline: connected && !theater && !detached,
    show: detached ? remoteWindow.show : undefined,
    error: theater ? theaterError : detached ? remoteWindow.error : undefined,
  };
}

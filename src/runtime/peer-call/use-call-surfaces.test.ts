// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { PerspectiveCamera } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteCallWindowModel } from "./remote-call-window";
import type { RoomCall } from "./room-call";
import { useCallSurfaces } from "./use-call-surfaces";

const bridge = vi.hoisted(() => ({
  native: vi.fn(),
  theater: vi.fn(),
  runtime: vi.fn(),
  show: vi.fn(),
  disposed: vi.fn(),
  theaterActive: vi.fn(),
}));
vi.mock("./remote-call-window", () => ({ useRemoteCallWindow: bridge.native }));
vi.mock("./theater-call-peer", () => ({ attachTheaterCallPeer: bridge.theater }));
vi.mock("../three-runtime/three-runtime", () => ({ getThreeRuntime: bridge.runtime }));

function room(): RoomCall {
  return {
    connected: true,
    remoteAvatarUrl: "blob:received",
    leave: vi.fn(),
    pause: vi.fn(),
    signaling: { roomId: "room", remoteEndpointId: "remote", remoteName: "Mafu" },
    peer: {
      motion: { sample: vi.fn(() => null) },
      audio: { sampleRemoteMouth: vi.fn(() => 0.45) },
    },
  } as unknown as RoomCall;
}
function projected(): RemoteCallWindowModel {
  return bridge.native.mock.calls[bridge.native.mock.calls.length - 1][0];
}
beforeEach(() => {
  vi.clearAllMocks();
  bridge.native.mockReturnValue({ show: bridge.show, error: undefined });
  bridge.theater.mockReturnValue({ dispose: bridge.disposed, setActive: bridge.theaterActive });
  const camera = new PerspectiveCamera(42, 0.67, 0.1, 35);
  camera.position.set(0.2, 1.65, 0.9);
  camera.zoom = 1.25;
  bridge.runtime.mockReturnValue({
    getCamera: () => camera,
    getCharacterAnchor: () => ({ x: 0, y: 1.63, z: 0 }),
  });
});
afterEach(cleanup);

describe("existing Yorishiro view call surfaces", () => {
  it("keeps the terminal peer inside the app and retains a hidden detached presentation on return", () => {
    const owner = room();
    const hook = renderHook(
      ({ mode }: { mode: string | null }) => useCallSurfaces(owner, mode, "ja"),
      {
        initialProps: { mode: null as string | null },
      },
    );
    expect(hook.result.current.inline).toBe(true);
    expect(hook.result.current.show).toBeUndefined();
    expect(projected()).toMatchObject({ ownerKey: "room:remote", visible: false });
    hook.rerender({ mode: "companion" });
    expect(hook.result.current.inline).toBe(false);
    expect(hook.result.current.show).toBe(bridge.show);
    expect(projected()).toMatchObject({ ownerKey: "room:remote", visible: true, mode: "portrait" });
    hook.rerender({ mode: null });
    expect(hook.result.current.inline).toBe(true);
    expect(hook.result.current.show).toBeUndefined();
    expect(projected()).toMatchObject({ ownerKey: "room:remote", visible: false });
    Object.assign(owner, { connected: false });
    hook.rerender({ mode: null });
    expect(hook.result.current.inline).toBe(false);
    expect(projected().ownerKey).toBeNull();
    expect(owner.leave).not.toHaveBeenCalled();
    expect(owner.pause).not.toHaveBeenCalled();
  });

  it.each([
    ["portrait", "call"],
    ["companion", "portrait"],
  ] as const)("preserves %s and projects only the remote resident into a separate native %s view", (viewMode, projectedMode) => {
    const owner = room();
    const hook = renderHook(() => useCallSurfaces(owner, viewMode, "ja"));
    expect(bridge.theater).not.toHaveBeenCalled();
    expect(projected()).toMatchObject({
      ownerKey: "room:remote",
      visible: true,
      mode: projectedMode,
      label: "Mafu",
      avatarUrl: "blob:received",
    });
    expect(projected().sampleMouth()).toBe(0.45);
    expect(projected().sampleCamera()).toMatchObject({
      position: [0.2, 1.65, 0.9],
      fov: 42,
      near: 0.1,
      far: 35,
      anchorY: 1.63,
      anchor: [0, 1.63, 0],
    });
    hook.unmount();
    expect(owner.leave).not.toHaveBeenCalled();
    expect(owner.pause).not.toHaveBeenCalled();
  });

  it("attaches a peer to the actual theater scene and switches presentation without changing the call", () => {
    const owner = room();
    const hook = renderHook(({ mode }) => useCallSurfaces(owner, mode, "ja"), {
      initialProps: { mode: "theater" },
    });
    expect(bridge.theater).toHaveBeenCalledOnce();
    expect(bridge.theater.mock.calls[0][0].avatarUrl).toBe("blob:received");
    expect(projected().visible).toBe(false);
    hook.rerender({ mode: "portrait" });
    expect(bridge.disposed).not.toHaveBeenCalled();
    expect(bridge.theaterActive).toHaveBeenLastCalledWith(false);
    expect(projected().visible).toBe(true);
    expect(projected().mode).toBe("call");
    hook.rerender({ mode: "theater" });
    expect(bridge.theater).toHaveBeenCalledOnce();
    expect(bridge.theaterActive).toHaveBeenLastCalledWith(true);
    expect(projected().visible).toBe(false);
    hook.rerender({ mode: "immersive" });
    expect(bridge.theater).toHaveBeenCalledOnce();
    expect(bridge.theaterActive).toHaveBeenLastCalledWith(true);
    expect(hook.result.current.inline).toBe(false);
    expect(projected().visible).toBe(false);
    expect(bridge.disposed).not.toHaveBeenCalled();
    hook.unmount();
    expect(bridge.disposed).toHaveBeenCalledOnce();
    expect(owner.leave).not.toHaveBeenCalled();
    expect(owner.pause).not.toHaveBeenCalled();
  });

  it("handles mutable RoomCall connection/avatar updates and clears projection on disconnection", () => {
    const owner = room();
    Object.assign(owner, { connected: false, remoteAvatarUrl: null });
    const hook = renderHook(() => useCallSurfaces(owner, "theater", "en"));
    expect(projected().ownerKey).toBeNull();
    expect(bridge.theater).not.toHaveBeenCalled();
    Object.assign(owner, { connected: true, remoteAvatarUrl: "blob:arrived" });
    hook.rerender();
    expect(bridge.theater).toHaveBeenCalledOnce();
    expect(projected().avatarUrl).toBe("blob:arrived");
    Object.assign(owner, { remoteAvatarUrl: "blob:replacement" });
    hook.rerender();
    expect(bridge.disposed).toHaveBeenCalledOnce();
    expect(bridge.theater).toHaveBeenCalledTimes(2);
    Object.assign(owner, { connected: false });
    hook.rerender();
    expect(bridge.disposed).toHaveBeenCalledTimes(2);
    expect(projected().ownerKey).toBeNull();
    expect(projected().avatarUrl).toBeNull();
    expect(owner.leave).not.toHaveBeenCalled();
  });

  it("keeps the current surface stable across repeated state updates and samples current camera settings", () => {
    const owner = room();
    const hook = renderHook(() => useCallSurfaces(owner, "theater", "ja"));
    hook.rerender();
    hook.rerender();
    expect(bridge.theater).toHaveBeenCalledOnce();
    expect(bridge.disposed).not.toHaveBeenCalled();
    const camera = bridge.runtime().getCamera();
    camera.position.z = 1.4;
    expect(projected().sampleCamera().position[2]).toBe(1.4);
    act(() => bridge.theater.mock.calls[0][0].onState("error", "Remote avatar failed"));
    expect(hook.result.current.error).toBe("Remote avatar failed");
  });
});

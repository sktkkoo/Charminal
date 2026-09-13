// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { PerspectiveCamera, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenePackEntry } from "../scene-pack-registry";
import type { NativeCallAvatarProps } from "./call-avatar";
import { CallResidentPanel } from "./call-resident-panel";
import type { CallSceneAppearance } from "./call-scene-state";
import type { RoomCall } from "./room-call";

const mocks = vi.hoisted(() => ({
  sampleScene: vi.fn(),
  runtime: vi.fn(),
  avatar: vi.fn<(props: NativeCallAvatarProps) => void>(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

vi.mock("./call-scene-state", () => ({ sampleCallScene: mocks.sampleScene }));
vi.mock("../three-runtime/three-runtime", () => ({ getThreeRuntime: mocks.runtime }));
vi.mock("./call-avatar", () => ({
  NativeCallAvatar(props: NativeCallAvatarProps) {
    mocks.avatar(props);
    useEffect(() => {
      mocks.mounted();
      return () => mocks.unmounted();
    }, []);
    return <canvas aria-label={props.label} />;
  },
}));

function scene(id: string): ScenePackEntry {
  return {
    id,
    origin: "bundled",
    scene: { id, layers: [] },
    manifest: {
      id,
      type: "scene",
      version: "1.0.0",
      yorishiroVersion: "^0.7.0",
      entry: "scene.tsx",
    },
    component: () => null,
  };
}

function call(): RoomCall {
  return {
    signaling: { remoteName: "Mai" },
    connected: true,
    remoteAvatarUrl: "blob:http://localhost/mai",
    paused: false,
    ready: true,
    error: "",
    peer: {
      motion: { sample: vi.fn(() => null) },
      audio: { sampleRemoteMouth: vi.fn(() => 0.25) },
    },
  } as unknown as RoomCall;
}

let appearance: CallSceneAppearance;
let camera: PerspectiveCamera;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  camera = new PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 1.4, 2);
  mocks.runtime.mockReturnValue({
    getCamera: () => camera,
    getCharacterAnchor: () => new Vector3(0, 1.6, 0),
  });
  appearance = {
    source: { origin: "bundled", id: "cafe" },
    scene: { id: "cafe", layers: [] },
    controls: { "lights.window": 1.15 },
    renderer: {
      toneMapping: 4,
      toneMappingExposure: 1,
      outputColorSpace: "srgb",
      shadowMapEnabled: true,
      shadowMapType: 1,
    },
    background: "#141619",
  };
  mocks.sampleScene.mockImplementation(() => structuredClone(appearance));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("terminal call resident panel", () => {
  it("loads lazily once, retains its view across modes, and pauses sampling while hidden", () => {
    const room = call();
    const entry = scene("cafe");
    const view = render(
      <CallResidentPanel room={room} sceneEntry={entry} language="ja" active={false} />,
    );
    expect(mocks.mounted).not.toHaveBeenCalled();
    expect(mocks.sampleScene).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<CallResidentPanel room={room} sceneEntry={entry} language="ja" active />);
    const canvas = screen.getByLabelText("Mai");
    expect(mocks.mounted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    view.rerender(
      <CallResidentPanel room={room} sceneEntry={entry} language="ja" active={false} />,
    );
    expect(view.container.querySelector("aside")?.hidden).toBe(true);
    expect(mocks.avatar.mock.lastCall?.[0].active).toBe(false);
    expect(mocks.unmounted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    appearance.controls["lights.window"] = 0.5;
    view.rerender(<CallResidentPanel room={room} sceneEntry={entry} language="ja" active />);
    expect(screen.getByLabelText("Mai")).toBe(canvas);
    expect(mocks.mounted).toHaveBeenCalledOnce();
    expect(mocks.avatar.mock.lastCall?.[0].appearance?.controls["lights.window"]).toBe(0.5);

    view.rerender(
      <CallResidentPanel room={call()} sceneEntry={entry} language="ja" active={false} />,
    );
    expect(mocks.unmounted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses the loaded scene and retains the avatar while controls and scenes change", () => {
    const room = call();
    const cafe = scene("cafe");
    const view = render(<CallResidentPanel room={room} sceneEntry={cafe} language="ja" />);
    const canvas = screen.getByLabelText("Mai");
    expect(mocks.avatar.mock.lastCall?.[0].sceneEntry).toBe(cafe);
    expect(mocks.avatar.mock.lastCall?.[0].appearance).toEqual(appearance);
    const renders = mocks.avatar.mock.calls.length;
    act(() => vi.advanceTimersByTime(300));
    expect(mocks.avatar).toHaveBeenCalledTimes(renders);

    appearance.controls["lights.window"] = 0.4;
    act(() => vi.advanceTimersByTime(100));
    expect(mocks.avatar.mock.lastCall?.[0].appearance?.controls["lights.window"]).toBe(0.4);

    const grass = scene("grass");
    appearance = { ...appearance, source: { origin: "bundled", id: "grass" }, scene: grass.scene };
    view.rerender(<CallResidentPanel room={room} sceneEntry={grass} language="ja" />);
    expect(mocks.avatar.mock.lastCall?.[0].sceneEntry).toBe(grass);
    expect(mocks.avatar.mock.lastCall?.[0].appearance?.scene?.id).toBe("grass");
    expect(screen.getByLabelText("Mai")).toBe(canvas);
    expect(mocks.mounted).toHaveBeenCalledOnce();
    expect(mocks.unmounted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const samples = mocks.sampleScene.mock.calls.length;
    act(() => vi.advanceTimersByTime(500));
    expect(mocks.sampleScene).toHaveBeenCalledTimes(samples);
  });

  it("samples the current peer and main camera at draw time without owning their lifecycle", () => {
    const first = call();
    const entry = scene("cafe");
    const view = render(<CallResidentPanel room={first} sceneEntry={entry} language="en" />);
    const initial = mocks.avatar.mock.lastCall?.[0];
    expect(initial?.sampleMouth?.()).toBe(0.25);
    expect(initial?.sampleCamera?.()).toEqual({
      position: [0, 1.4, 2],
      quaternion: [0, 0, 0, 1],
      fov: 32,
      zoom: 1,
      near: 0.1,
      far: 100,
      anchorY: 1.6,
      anchor: [0, 1.6, 0],
    });
    const next = call();
    if (!next.peer) throw new Error("The test call must have a peer");
    vi.mocked(next.peer.audio.sampleRemoteMouth).mockReturnValue(0.8);
    view.rerender(<CallResidentPanel room={next} sceneEntry={entry} language="en" />);
    camera.position.z = 3;
    expect(initial?.sampleMouth?.()).toBe(0.8);
    expect(initial?.sampleCamera?.()?.position).toEqual([0, 1.4, 3]);
    initial?.sampleMotion();
    expect(next.peer?.motion.sample).toHaveBeenCalledOnce();
    next.peer = null;
    expect(initial?.sampleMotion()).toBeNull();
    expect(initial?.sampleMouth?.()).toBe(0);
  });

  it("shows a waiting state until the peer avatar is available", () => {
    const room = call();
    room.remoteAvatarUrl = null;
    room.paused = true;
    room.error = "Avatar exceeds the transfer limit";
    const entry = scene("cafe");
    const view = render(<CallResidentPanel room={room} sceneEntry={entry} language="ja" />);
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toBe("Mai・通話相手");
    expect(screen.getByRole("status").textContent).toBe("相手の姿を待っています…");
    expect(screen.getByText("AIの会話は停止中")).toBeTruthy();
    expect(screen.queryByText("AIに接続できませんでした")).toBeNull();
    expect(mocks.mounted).not.toHaveBeenCalled();
    room.remoteAvatarUrl = "blob:http://localhost/mai";
    view.rerender(<CallResidentPanel room={room} sceneEntry={entry} language="en" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("AI conversation stopped")).toBeTruthy();
    expect(screen.queryByText("AI connection failed")).toBeNull();
    expect(mocks.mounted).toHaveBeenCalledOnce();
  });
});

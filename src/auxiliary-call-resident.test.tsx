// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteCallWindowFrame } from "./runtime/peer-call/remote-call-window";

const bridge = vi.hoisted(() => ({
  listen: vi.fn(),
  read: vi.fn(),
  avatar: vi.fn(),
  scene: vi.fn(),
  loadScene: vi.fn(),
  avatarRender: vi.fn(),
  hide: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("./runtime/peer-call/remote-call-window", () => ({
  listenRemoteCallWindow: bridge.listen,
  readRemoteCallWindow: bridge.read,
  readRemoteCallAvatar: bridge.avatar,
  readRemoteCallScene: bridge.scene,
  hideRemoteCallWindow: bridge.hide,
}));
vi.mock("./runtime/peer-call/call-scene-loader", () => ({ loadCallScene: bridge.loadScene }));
vi.mock("./runtime/peer-call/avatar-transfer", () => ({ validateAvatarGlb: () => true }));
vi.mock("./runtime/peer-call/call-avatar", () => ({
  NativeCallAvatar: (props: { avatarUrl: string; label: string }) => {
    bridge.avatarRender(props);
    return (
      <div data-testid="resident" data-url={props.avatarUrl}>
        {props.label}
      </div>
    );
  },
}));

import AuxiliaryCallResident from "./auxiliary-call-resident";

let receive!: (value: RemoteCallWindowFrame) => void;
const frame = (sequence: number, leaseId = "lease"): RemoteCallWindowFrame => ({
  leaseId,
  sequence,
  avatarRevision: 1,
  label: "Mafu",
  language: "ja",
  mode: "call",
  motion: null,
  mouth: [0, 0, 0, 0, 0],
  camera: {
    position: [0, 1.5, 1],
    quaternion: [0, 0, 0, 1],
    fov: 35,
    near: 0.1,
    far: 20,
    anchorY: 1.5,
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  bridge.listen.mockImplementation(async (callback) => {
    receive = callback;
    return vi.fn();
  });
  bridge.read.mockResolvedValue(null);
  bridge.avatar.mockResolvedValue(new ArrayBuffer(24));
  bridge.scene.mockResolvedValue(null);
  bridge.create.mockReturnValue("blob:own-window");
  URL.createObjectURL = bridge.create;
  URL.revokeObjectURL = bridge.revoke;
});
afterEach(cleanup);

it("uses received bytes in its own WebView blob and revokes it when the view closes", async () => {
  bridge.read.mockResolvedValue(frame(1));
  const view = render(<AuxiliaryCallResident />);
  await act(async () => {});
  expect(bridge.avatar).toHaveBeenCalledWith("lease", 1);
  expect(screen.getByTestId("resident").getAttribute("data-url")).toBe("blob:own-window");
  act(() => receive(frame(2)));
  expect(bridge.avatar).toHaveBeenCalledOnce();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "相手のウィンドウを隠す" })),
  );
  expect(bridge.hide).toHaveBeenCalledWith("lease");
  view.unmount();
  expect(bridge.revoke).toHaveBeenCalledWith("blob:own-window");
});
it("ignores late snapshots and old avatar read results after participant replacement", async () => {
  let finishSnapshot!: (value: RemoteCallWindowFrame) => void;
  bridge.read.mockReturnValue(
    new Promise((resolve) => {
      finishSnapshot = resolve;
    }),
  );
  let finishAvatar!: (value: ArrayBuffer) => void;
  bridge.avatar.mockReturnValueOnce(
    new Promise((resolve) => {
      finishAvatar = resolve;
    }),
  );
  render(<AuxiliaryCallResident />);
  await act(async () => {});
  await act(async () => receive(frame(3)));
  await act(async () => finishSnapshot({ ...frame(1), label: "Old" }));
  await act(async () => receive({ ...frame(4, "next"), label: "Next" }));
  expect(screen.getByTestId("resident").textContent).toBe("Next");
  await act(async () => finishAvatar(new ArrayBuffer(24)));
  expect(bridge.create).toHaveBeenCalledOnce();
  expect(screen.getByTestId("resident").textContent).toBe("Next");
});

it("loads the main scene once and applies layer/light control changes without reloading avatar bytes", async () => {
  const entry = {
    id: "room",
    origin: "bundled",
    manifest: {},
    scene: { id: "room", layers: [] },
    component: () => null,
  };
  const appearance = {
    source: { origin: "bundled", id: "room" },
    scene: {
      id: "room",
      layers: [
        { id: "wall", role: "background", backgroundColor: "#654321" },
        { id: "avatar", role: "character" },
      ],
    },
    controls: { "lights.fill": 0.7 },
    background: "#112233",
    renderer: {},
  };
  bridge.loadScene.mockResolvedValue(entry);
  bridge.scene.mockResolvedValue(appearance);
  bridge.read.mockResolvedValue({ ...frame(1), sceneRevision: 1 });
  render(<AuxiliaryCallResident />);
  await act(async () => {});
  expect(bridge.scene).toHaveBeenCalledWith("lease", 1);
  expect(bridge.loadScene).toHaveBeenCalledOnce();
  expect(screen.getByRole("main").style.background).toBe("rgb(17, 34, 51)");
  expect(bridge.avatarRender.mock.lastCall?.[0].sceneEntry).toBe(entry);
  bridge.scene.mockResolvedValue({ ...appearance, controls: { "lights.fill": 1.4 } });
  await act(async () => receive({ ...frame(2), sceneRevision: 2 }));
  expect(bridge.avatarRender.mock.lastCall?.[0].appearance.controls).toEqual({
    "lights.fill": 1.4,
  });
  expect(bridge.loadScene).toHaveBeenCalledOnce();
  expect(bridge.avatar).toHaveBeenCalledOnce();
});
it("keeps loaded avatar and scene through Call/Portrait and hidden transitions, pausing the existing view", async () => {
  const scene = { id: "room", layers: [] };
  const entry = { id: "room", origin: "bundled", manifest: {}, scene, component: () => null };
  bridge.loadScene.mockResolvedValue(entry);
  bridge.scene.mockResolvedValue({
    source: { origin: "bundled", id: "room" },
    scene,
    controls: {},
    background: "#112233",
    renderer: {},
  });
  bridge.read.mockResolvedValue({ ...frame(1), sceneRevision: 1, visible: true });
  render(<AuxiliaryCallResident />);
  await act(async () => {});
  const resident = screen.getByTestId("resident");
  await act(async () =>
    receive({ ...frame(2), sceneRevision: 1, mode: "portrait", visible: true }),
  );
  expect(bridge.avatarRender.mock.lastCall?.[0].active).toBe(true);
  await act(async () =>
    receive({ ...frame(3), sceneRevision: 1, mode: "portrait", visible: false }),
  );
  expect(bridge.avatarRender.mock.lastCall?.[0].active).toBe(false);
  await act(async () => receive({ ...frame(4), sceneRevision: 1, visible: true }));
  expect(bridge.avatarRender.mock.lastCall?.[0].active).toBe(true);
  expect(screen.getByTestId("resident")).toBe(resident);
  expect(bridge.avatar).toHaveBeenCalledOnce();
  expect(bridge.scene).toHaveBeenCalledOnce();
  expect(bridge.loadScene).toHaveBeenCalledOnce();
  expect(bridge.revoke).not.toHaveBeenCalled();
});
it("does not display a late scene snapshot after a newer revision", async () => {
  let finish!: (value: unknown) => void;
  bridge.scene.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  bridge.read.mockResolvedValue({ ...frame(1), sceneRevision: 1 });
  render(<AuxiliaryCallResident />);
  await act(async () => {});
  bridge.scene.mockResolvedValue({
    source: null,
    scene: null,
    controls: {},
    background: "#112233",
    renderer: {},
  });
  await act(async () => receive({ ...frame(2), sceneRevision: 2 }));
  await act(async () =>
    finish({ source: null, scene: null, controls: {}, background: "#ffffff", renderer: {} }),
  );
  expect(screen.getByRole("main").style.background).toBe("rgb(17, 34, 51)");
});

it("finishes a pending scene import while light controls keep updating", async () => {
  let finish!: (value: unknown) => void;
  bridge.loadScene.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const scene = { id: "room", layers: [] };
  const appearance = {
    source: { origin: "bundled", id: "room" },
    scene,
    controls: { ambient: 0.5 },
    background: "#112233",
    renderer: {},
  };
  bridge.scene.mockResolvedValue(appearance);
  bridge.read.mockResolvedValue({ ...frame(1), sceneRevision: 1 });
  render(<AuxiliaryCallResident />);
  await act(async () => {});
  for (let sequence = 2; sequence < 5; sequence++) {
    bridge.scene.mockResolvedValue({ ...appearance, controls: { ambient: sequence } });
    await act(async () => receive({ ...frame(sequence), sceneRevision: sequence }));
  }
  expect(bridge.loadScene).toHaveBeenCalledOnce();
  const entry = { id: "room", origin: "bundled", manifest: {}, scene, component: () => null };
  await act(async () => finish(entry));
  expect(bridge.avatarRender.mock.lastCall?.[0].sceneEntry).toBe(entry);
  expect(bridge.avatarRender.mock.lastCall?.[0].appearance.controls).toEqual({ ambient: 4 });
});

it("keeps a scene import failure visible when metadata succeeds, until a new source loads", async () => {
  const appearance = {
    source: { origin: "user", id: "room", generation: 1 },
    scene: { id: "room", layers: [] },
    controls: { ambient: 0.5 },
    background: "#112233",
    renderer: {},
  };
  bridge.loadScene.mockRejectedValueOnce(new Error("Invalid local scene module"));
  bridge.scene.mockResolvedValue(appearance);
  bridge.read.mockResolvedValue({ ...frame(1), sceneRevision: 1 });
  render(<AuxiliaryCallResident />);
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe("シーンを読み込めませんでした。");

  bridge.scene.mockResolvedValue({ ...appearance, controls: { ambient: 1 } });
  await act(async () => receive({ ...frame(2), sceneRevision: 2 }));
  expect(bridge.loadScene).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert").textContent).toBe("シーンを読み込めませんでした。");
  expect(bridge.avatarRender.mock.lastCall?.[0].sceneEntry).toBeNull();

  const nextEntry = {
    id: "room",
    origin: "user",
    manifest: {},
    scene: appearance.scene,
    component: () => null,
  };
  bridge.loadScene.mockResolvedValueOnce(nextEntry);
  bridge.scene.mockResolvedValue({
    ...appearance,
    source: { ...appearance.source, generation: 2 },
  });
  await act(async () => receive({ ...frame(3), sceneRevision: 3 }));
  expect(bridge.loadScene).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(bridge.avatarRender.mock.lastCall?.[0].sceneEntry).toBe(nextEntry);
});

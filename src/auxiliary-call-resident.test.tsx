// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteCallWindowFrame } from "./runtime/peer-call/remote-call-window";

const bridge = vi.hoisted(() => ({
  listen: vi.fn(),
  read: vi.fn(),
  avatar: vi.fn(),
  hide: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("./runtime/peer-call/remote-call-window", () => ({
  listenRemoteCallWindow: bridge.listen,
  readRemoteCallWindow: bridge.read,
  readRemoteCallAvatar: bridge.avatar,
  hideRemoteCallWindow: bridge.hide,
}));
vi.mock("./runtime/peer-call/avatar-transfer", () => ({ validateAvatarGlb: () => true }));
vi.mock("./runtime/peer-call/call-avatar", () => ({
  NativeCallAvatar: ({ avatarUrl, label }: { avatarUrl: string; label: string }) => (
    <div data-testid="resident" data-url={avatarUrl}>
      {label}
    </div>
  ),
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

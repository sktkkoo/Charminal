// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CameraPreviewFrame } from "./runtime/camera-preview-window";

const bridge = vi.hoisted(() => ({ listen: vi.fn(), read: vi.fn(), request: vi.fn() }));
vi.mock("./runtime/camera-preview-window", () => ({
  listenCameraPreview: bridge.listen,
  readCameraPreview: bridge.read,
  requestCameraPreviewAction: bridge.request,
}));

import AuxiliaryCameraPreview from "./auxiliary-camera-preview";

let receive: (frame: CameraPreviewFrame | null) => void;
const unlisten = vi.fn();
const frame = (sequence: number): CameraPreviewFrame => ({
  leaseId: "lease",
  imageDataUrl: `data:image/jpeg;base64,${sequence}`,
  language: "ja",
  sequence,
});
beforeEach(() => {
  vi.clearAllMocks();
  bridge.listen.mockImplementation(async (cb) => {
    receive = cb;
    return unlisten;
  });
  bridge.request.mockResolvedValue(undefined);
});
afterEach(cleanup);

it.each([
  null,
  frame(1),
])("keeps a newer event when a stale initial snapshot arrives: %s", async (snapshot) => {
  let finish!: (value: CameraPreviewFrame | null) => void;
  bridge.read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<AuxiliaryCameraPreview />);
  await act(async () => {});
  act(() => receive(frame(2)));
  await act(async () => finish(snapshot));
  expect(screen.getByRole("img").getAttribute("src")).toBe(frame(2).imageDataUrl);
  act(() => receive(frame(1)));
  expect(screen.getByRole("img").getAttribute("src")).toBe(frame(2).imageDataUrl);
  expect(view.container.querySelector("video")).toBeNull();
  view.unmount();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("routes stop and return through the current lease without owning the camera", async () => {
  bridge.read.mockResolvedValue(frame(3));
  render(<AuxiliaryCameraPreview />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "ヨリシロ内に戻す" })));
  expect(bridge.request).toHaveBeenLastCalledWith("lease", "attach");
  act(() => receive({ ...frame(4), leaseId: "next-lease" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "カメラ共有を停止" })));
  expect(bridge.request).toHaveBeenLastCalledWith("next-lease", "stop");
});

it("disposes a listener that resolves after unmount", async () => {
  let finish!: (value: () => void) => void;
  bridge.listen.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<AuxiliaryCameraPreview />);
  view.unmount();
  await act(async () => finish(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
  expect(bridge.read).not.toHaveBeenCalled();
});

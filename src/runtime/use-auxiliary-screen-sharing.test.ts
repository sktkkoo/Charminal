// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenSharingAuxiliaryModel } from "./auxiliary-windows";
import { useAuxiliaryScreenSharing } from "./use-auxiliary-screen-sharing";

const native = vi.hoisted(() => ({
  publish: vi.fn(),
  open: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => {
    if (command === "auxiliary_window_publish") return native.publish(args);
    if (command === "auxiliary_window_open") return native.open(args);
    throw new Error(`Unexpected native command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: native.listen }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  native.publish.mockResolvedValue(undefined);
  native.open.mockResolvedValue(undefined);
  native.listen.mockResolvedValue(native.unlisten);
});
afterEach(cleanup);

it("clears a publication error raised during an explicit open once its retry succeeds", async () => {
  let rejectPublication!: (error: Error) => void;
  let completeRetry!: () => void;
  native.publish
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPublication = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeRetry = resolve;
        }),
    );
  const model: ScreenSharingAuxiliaryModel = {
    ownerKey: "main-owner",
    available: true,
    active: true,
    busy: false,
    pointersEnabled: true,
    pointersReady: true,
    sources: [{ id: 1, name: "Display 1" }],
    sourceId: 1,
    intervalSeconds: 30,
    language: "ja",
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    refreshSources: vi.fn(async () => {}),
    clearAnnotations: vi.fn(async () => {}),
    retryPointers: vi.fn(async () => {}),
    setPointersEnabled: vi.fn(async () => {}),
    setSourceId: vi.fn(),
    setIntervalSeconds: vi.fn(),
  };
  const view = renderHook(() => useAuxiliaryScreenSharing(model));
  await waitFor(() => expect(native.publish).toHaveBeenCalledOnce());
  let opening!: Promise<void>;
  act(() => {
    opening = view.result.current.open();
  });
  await act(async () => rejectPublication(new Error("Controls publication failed")));
  await waitFor(() => expect(native.publish).toHaveBeenCalledTimes(2));
  expect(view.result.current.error).toContain("Controls publication failed");
  expect(native.open).not.toHaveBeenCalled();
  await act(async () => {
    completeRetry();
    await opening;
  });
  expect(view.result.current.error).toBeUndefined();
  expect(native.open).toHaveBeenCalledOnce();
  expect(model.start).not.toHaveBeenCalled();
  expect(model.stop).not.toHaveBeenCalled();
  view.unmount();
  expect(native.unlisten).toHaveBeenCalledOnce();
});

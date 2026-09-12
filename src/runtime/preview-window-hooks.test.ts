// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCameraPreviewWindow } from "./camera-preview-window";
import { useScreenPreviewWindow } from "./screen-preview-window";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: native.listen }),
}));
beforeEach(() => {
  let lease = 0;
  native.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command.endsWith("_begin") ? `lease-${++lease}` : undefined,
    );
  native.listen.mockReset().mockResolvedValue(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("restores an external screen preview after hiding and retains an explicit attach", async () => {
  const initialProps = {
    sourceKey: "share-a",
    frame: { imageDataUrl: "data:image/jpeg;base64,AAAA" },
    language: "ja",
    onStop: vi.fn(),
    visible: true,
    initiallyDetached: true,
  };
  const { result, rerender } = renderHook(useScreenPreviewWindow, { initialProps });
  await waitFor(() => expect(result.current.detached).toBe(true));
  rerender({ ...initialProps, visible: false });
  await waitFor(() => expect(result.current.detached).toBe(false));
  rerender({ ...initialProps, initiallyDetached: false });
  await waitFor(() => expect(result.current.detached).toBe(true));
  await act(() => result.current.attach());
  rerender({ ...initialProps, visible: false });
  rerender(initialProps);
  expect(result.current.detached).toBe(false);
  expect(
    native.invoke.mock.calls.filter(([command]) => command === "screen_preview_open"),
  ).toHaveLength(2);
});

it("keeps a manually detached camera external through hide/show and a view change", async () => {
  const initialProps = {
    stream: {} as MediaStream,
    language: "ja",
    onStop: vi.fn(),
    visible: true,
    initiallyDetached: false,
  };
  const { result, rerender } = renderHook(useCameraPreviewWindow, { initialProps });
  await act(() => result.current.detach());
  expect(result.current.detached).toBe(true);
  rerender({ ...initialProps, visible: false, initiallyDetached: true });
  await waitFor(() => expect(result.current.detached).toBe(false));
  rerender(initialProps);
  await waitFor(() => expect(result.current.detached).toBe(true));
  expect(
    native.invoke.mock.calls.filter(([command]) => command === "camera_preview_open"),
  ).toHaveLength(2);
});

it("never renders inline while an external screen preview opens or reopens", async () => {
  const renders: boolean[] = [];
  const initialProps = {
    sourceKey: "share-flicker",
    frame: { imageDataUrl: "data:image/jpeg;base64,AAAA" },
    language: "ja",
    onStop: vi.fn(),
    visible: true,
    initiallyDetached: true,
  };
  const { result, rerender } = renderHook(
    (props) => {
      const preview = useScreenPreviewWindow(props);
      renders.push(preview.inlineVisible);
      return preview;
    },
    { initialProps },
  );
  await waitFor(() => expect(result.current.detached).toBe(true));
  rerender({ ...initialProps, visible: false });
  await waitFor(() => expect(result.current.detached).toBe(false));
  rerender({ ...initialProps, initiallyDetached: false });
  await waitFor(() => expect(result.current.detached).toBe(true));
  expect(renders.every((visible) => !visible)).toBe(true);
  await act(() => result.current.attach());
  expect(result.current.inlineVisible).toBe(true);
});

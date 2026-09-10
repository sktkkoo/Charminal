// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraPreview } from "./camera-preview";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("local camera preview", () => {
  it("offers explicit detach and attach controls without acquiring a second camera", () => {
    const onStop = vi.fn();
    const onDetach = vi.fn();
    const onAttach = vi.fn();
    const view = render(
      <CameraPreview
        stream={{} as MediaStream}
        onStop={onStop}
        onDetach={onDetach}
        language="ja"
      />,
    );
    expect(screen.getByText("停止")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "別ウィンドウで開く" }));
    expect(onDetach).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
    view.rerender(
      <CameraPreview
        detached
        imageDataUrl="data:image/jpeg;base64,YQ=="
        onStop={onStop}
        onAttach={onAttach}
        language="ja"
      />,
    );
    expect(view.container.querySelector("video")).toBeNull();
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/jpeg;base64,YQ==");
    fireEvent.click(screen.getByRole("button", { name: "ヨリシロ内に戻す" }));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it("uses the existing stream and leaves capture ownership intact when unmounted", () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const onStop = vi.fn();
    const view = render(<CameraPreview stream={stream} onStop={onStop} language="ja" />);
    const video = screen.getByLabelText("共有中のカメラ映像") as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "カメラ共有を停止" }));
    expect(onStop).toHaveBeenCalledOnce();
    view.unmount();
    expect(video.srcObject).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it("restarts the shutter only for a new capture and reports sharing only after delivery", () => {
    const props = { stream: {} as MediaStream, onStop: vi.fn(), language: "ja" };
    const view = render(<CameraPreview {...props} />);
    expect(view.container.querySelector(".camera-preview-flash")).toBeNull();
    view.rerender(<CameraPreview {...props} lastCapturedAt={1000} />);
    const shutter = view.container.querySelector(".camera-preview-flash");
    expect(shutter).toBeTruthy();
    expect(screen.getByText("静止画を撮影しました")).toBeTruthy();
    view.rerender(<CameraPreview {...props} lastCapturedAt={1000} lastSharedAt={1000} />);
    expect(view.container.querySelector(".camera-preview-flash")).toBe(shutter);
    expect(screen.getByText("静止画を共有しました")).toBeTruthy();
    view.rerender(<CameraPreview {...props} lastCapturedAt={2000} lastSharedAt={1000} />);
    expect(view.container.querySelector(".camera-preview-flash")).not.toBe(shutter);
    expect(screen.queryByText("静止画を共有しました")).toBeNull();
  });
});

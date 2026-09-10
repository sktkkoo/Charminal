// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCameraSources, openCamera } from "./camera-capture";

class VideoTrack extends EventTarget {
  readyState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("camera capture ownership", () => {
  let track: VideoTrack;
  let stream: MediaStream;
  let video: HTMLVideoElement;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let enumerateDevices: ReturnType<typeof vi.fn>;
  let play: ReturnType<typeof vi.spyOn>;
  let drawImage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    track = new VideoTrack();
    stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    getUserMedia = vi.fn().mockResolvedValue(stream);
    enumerateDevices = vi.fn().mockResolvedValue([]);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices } });
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLVideoElement,
    ) {
      video = this;
      Object.defineProperties(this, {
        readyState: { configurable: true, value: 2 },
        videoWidth: { configurable: true, value: 1920 },
        videoHeight: { configurable: true, value: 1080 },
      });
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,YQ==",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("enumerates without opening a camera and keeps device identity across reorder", async () => {
    const first = { kind: "videoinput", deviceId: "first", label: "Desk camera" };
    const second = { kind: "videoinput", deviceId: "second", label: "USB camera" };
    enumerateDevices.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([second, first]);
    const initial = await listCameraSources();
    const reordered = await listCameraSources();
    expect(reordered.find((source) => source.deviceId === "first")?.id).toBe(
      initial.find((source) => source.deviceId === "first")?.id,
    );
    expect(reordered.find((source) => source.deviceId === "second")?.id).toBe(
      initial.find((source) => source.deviceId === "second")?.id,
    );
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("does not request access when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(openCamera(undefined, controller.signal, vi.fn())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops a stream granted after cancellation before displaying or capturing it", async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const controller = new AbortController();
    const pending = openCamera(undefined, controller.signal, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    permission.resolve(stream);
    await rejected;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("requests only the selected video device and releases it on abort", async () => {
    const controller = new AbortController();
    const ended = vi.fn();
    const camera = await openCamera("selected-camera", controller.signal, ended);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        deviceId: { exact: "selected-camera" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    expect(camera.capture()).toMatchObject({
      width: 1600,
      height: 900,
      dataUrl: "data:image/jpeg;base64,YQ==",
    });
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1600, 900);
    controller.abort();
    camera.close();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(() => camera.capture()).toThrow();
    track.dispatchEvent(new Event("ended"));
    expect(ended).not.toHaveBeenCalled();
  });

  it("reports disconnection and rejects a stream with no live video track", async () => {
    const ended = vi.fn();
    const camera = await openCamera(undefined, new AbortController().signal, ended);
    track.dispatchEvent(new Event("ended"));
    expect(ended).toHaveBeenCalledOnce();
    camera.close();
    await expect(openCamera(undefined, new AbortController().signal, vi.fn())).rejects.toThrow(
      "live video track",
    );
  });

  it("releases the camera when video playback fails", async () => {
    play.mockRejectedValue(new Error("Playback failed"));
    await expect(openCamera(undefined, new AbortController().signal, vi.fn())).rejects.toThrow(
      "Playback failed",
    );
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("cancels while waiting for the first camera image", async () => {
    play.mockReturnValue(new Promise<void>(() => {}));
    const controller = new AbortController();
    const pending = openCamera(undefined, controller.signal, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("times out and releases a camera that never provides an image", async () => {
    vi.useFakeTimers();
    play.mockReturnValue(new Promise<void>(() => {}));
    const pending = openCamera(undefined, new AbortController().signal, vi.fn());
    const rejected = expect(pending).rejects.toThrow("did not provide an image");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

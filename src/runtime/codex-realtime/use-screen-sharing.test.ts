// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  screenAnnotationBegin,
  screenAnnotationClear,
  screenAnnotationDocument,
  screenAnnotationEnd,
  screenCaptureFrame,
  screenCaptureListSources,
  screenCaptureRequestPermission,
} from "../../bindings/tauri-commands";
import type { ScreenObservationFrame } from "./screen-observation";

let useScreenSharing: typeof import("./use-screen-sharing").useScreenSharing;

vi.mock("../../bindings/tauri-commands", () => ({
  screenAnnotationBegin: vi.fn(),
  screenAnnotationClear: vi.fn(),
  screenAnnotationDocument: vi.fn(),
  screenAnnotationEnd: vi.fn(),
  screenCaptureFrame: vi.fn(),
  screenCaptureListSources: vi.fn(),
  screenCaptureRequestPermission: vi.fn(),
}));

const frame = {
  frameId: "frame-1",
  sourceId: 1,
  sourceName: "Display 1",
  dataUrl: "data:image/jpeg;base64,YQ==",
  capturedAt: 1_700_000_000_000,
  width: 1280,
  height: 720,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useScreenSharing", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.resetModules();
    ({ useScreenSharing } = await import("./use-screen-sharing"));
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, name: "Display 1", width: 1920, height: 1080 },
    ]);
    vi.mocked(screenCaptureRequestPermission).mockResolvedValue(true);
    vi.mocked(screenAnnotationDocument).mockResolvedValue("document-1");
    vi.mocked(screenAnnotationBegin).mockResolvedValue(undefined);
    vi.mocked(screenAnnotationEnd).mockResolvedValue(undefined);
    vi.mocked(screenAnnotationClear).mockResolvedValue(undefined);
    vi.mocked(screenCaptureFrame).mockResolvedValue(frame);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function setup() {
    const share = vi.fn(async (_frame: ScreenObservationFrame, _signal: AbortSignal) => ({
      status: "shared" as const,
      capturedAt: new Date(frame.capturedAt).toISOString(),
    }));
    const hook = renderHook(
      ({ ownerKey, available }) => useScreenSharing({ available, ownerKey, share }),
      { initialProps: { ownerKey: "main:thread:active", available: true } },
    );
    return { ...hook, share };
  }

  it("lists sources without capture and ignores a permission grant after cancellation", async () => {
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValue(permission.promise);
    const { result, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    expect(screenCaptureRequestPermission).toHaveBeenCalledTimes(1);
    act(() => result.current.stop());
    await act(async () => {
      permission.resolve(true);
      await starting;
    });
    expect(result.current.active).toBe(false);
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it("does not overlap captures or deliver a frame after stop", async () => {
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValue(pending.promise);
    const { result, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    const shareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    expect(screenAnnotationBegin).toHaveBeenCalledWith(shareId, 1, "document-1");
    expect(screenCaptureFrame).toHaveBeenCalledWith(1, shareId);
    act(() => result.current.stop());
    expect(screenAnnotationEnd).toHaveBeenCalledWith(shareId);
    await act(async () => {
      pending.resolve(frame);
    });
    expect(share).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("allows an explicit refresh only after opt-in setup and joins an in-flight capture", async () => {
    const { result, share } = setup();
    await act(async () => result.current.captureNow());
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValueOnce(permission.promise);
    await act(async () => result.current.refreshSources());
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
      await result.current.captureNow();
    });
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    await act(async () => {
      permission.resolve(true);
      await starting;
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(pending.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.captureNow();
      second = result.current.captureNow();
    });
    expect(first).toBe(second);
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve({ ...frame, frameId: "refreshed", dataUrl: "data:image/jpeg;base64,Yg==" });
      await first;
    });
    expect(share).toHaveBeenCalledTimes(2);
    act(() => result.current.stop());
    await act(async () => result.current.captureNow());
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
  });

  it("resumes overdue periodic capture immediately after a slow delivery", async () => {
    const { result, share } = setup();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    share.mockReturnValueOnce(delivery.promise);
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => {
      delivery.resolve({ status: "shared", capturedAt: new Date(frame.capturedAt).toISOString() });
    });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    // The previous setInterval loop would discard the 30s tick and wait until
    // 60s. A due capture can now begin at 40s without overlapping delivery.
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
  });

  it("starts a replacement lease's first capture as soon as the old capture settles", async () => {
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(pending.promise);
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    act(() => result.current.stop());
    await act(async () => result.current.start());
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(frame));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);
  });

  it("reports stage durations without sending captured content to diagnostics", async () => {
    const capture = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(capture.promise);
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    const onTiming = vi.fn();
    const { result } = renderHook(() =>
      useScreenSharing({
        available: true,
        ownerKey: "private-owner",
        share: () => delivery.promise,
        onTiming,
      }),
    );
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await act(async () => capture.resolve(frame));
    await act(async () => vi.advanceTimersByTimeAsync(80));
    await act(async () =>
      delivery.resolve({ status: "shared", capturedAt: new Date(frame.capturedAt).toISOString() }),
    );
    expect(onTiming).toHaveBeenCalledExactlyOnceWith({
      reason: "periodic",
      captureMs: 100,
      contextMs: 80,
      totalMs: 180,
      outcome: "shared",
    });
  });

  it("supports five-second sampling, deduplicates pixels, and stops on owner change", async () => {
    const { result, rerender, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    act(() => result.current.setIntervalSeconds(5));
    await act(async () => {
      await result.current.start();
    });
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith(
      {
        frameId: frame.frameId,
        width: frame.width,
        height: frame.height,
        imageDataUrl: frame.dataUrl,
        source: frame.sourceName,
        capturedAt: new Date(frame.capturedAt).toISOString(),
      },
      expect.any(AbortSignal),
    );
    expect(result.current.lastObservedAt).toBe(frame.capturedAt);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledTimes(1);
    rerender({ ownerKey: "main:other-thread:active", available: true });
    expect(result.current.active).toBe(false);
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
  });

  it("shares a replacement frame reference even when its pixels are unchanged", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    vi.mocked(screenCaptureFrame).mockResolvedValueOnce({ ...frame, frameId: "after-expiry" });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(share).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenLastCalledWith(
      expect.objectContaining({ frameId: "after-expiry", imageDataUrl: frame.dataUrl }),
      expect.any(AbortSignal),
    );
  });

  it("fails visibly without continuing capture when delivery fails", async () => {
    const { result, share } = setup();
    share.mockRejectedValue(new Error("Image context is unsupported"));
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("unsupported");
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
  });

  it("does not send a burst of images while dragging the interval slider", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    for (let value = 5; value <= 60; value++) {
      act(() => result.current.setIntervalSeconds(value));
    }
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
  });

  it("serializes a cancelled native begin before a new sharing lease", async () => {
    const beginning = deferred<void>();
    vi.mocked(screenAnnotationBegin).mockReturnValueOnce(beginning.promise);
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    let firstStart!: Promise<void>;
    await act(async () => {
      firstStart = result.current.start();
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(1);
    const firstShareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    act(() => result.current.stop());
    expect(screenAnnotationEnd).toHaveBeenCalledWith(firstShareId);

    let secondStart!: Promise<void>;
    await act(async () => {
      secondStart = result.current.start();
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(1);
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    await act(async () => {
      beginning.resolve();
      await Promise.all([firstStart, secondStart]);
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(2);
    const secondShareId = vi.mocked(screenAnnotationBegin).mock.calls[1][0];
    expect(secondShareId).not.toBe(firstShareId);
    expect(screenAnnotationEnd).toHaveBeenLastCalledWith(firstShareId);
    const endCallOrder = vi.mocked(screenAnnotationEnd).mock.invocationCallOrder;
    expect(endCallOrder[endCallOrder.length - 1]).toBeLessThan(
      vi.mocked(screenAnnotationBegin).mock.invocationCallOrder[1],
    );
    expect(screenCaptureFrame).toHaveBeenCalledExactlyOnceWith(1, secondShareId);
    expect(result.current.active).toBe(true);
  });

  it("revokes a late native begin after unmount before another hook can start", async () => {
    const beginning = deferred<void>();
    vi.mocked(screenAnnotationBegin).mockReturnValueOnce(beginning.promise);
    const first = setup();
    await act(async () => first.result.current.refreshSources());
    let firstStart!: Promise<void>;
    await act(async () => {
      firstStart = first.result.current.start();
    });
    const firstShareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    first.unmount();
    expect(screenAnnotationEnd).toHaveBeenCalledWith(firstShareId);

    const second = setup();
    await act(async () => second.result.current.refreshSources());
    let secondStart!: Promise<void>;
    await act(async () => {
      secondStart = second.result.current.start();
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(1);
    await act(async () => {
      beginning.resolve();
      await Promise.all([firstStart, secondStart]);
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(2);
    expect(screenAnnotationEnd).toHaveBeenLastCalledWith(firstShareId);
    expect(first.share).not.toHaveBeenCalled();
    expect(second.share).toHaveBeenCalledTimes(1);
    expect(second.result.current.active).toBe(true);
  });

  it("ends the lease if native annotation setup fails, without capturing an image", async () => {
    vi.mocked(screenAnnotationBegin).mockRejectedValueOnce(new Error("Display unavailable"));
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("Display unavailable");
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    expect(screenCaptureFrame).not.toHaveBeenCalled();
  });

  it("clears markers without ending screen sharing or requesting another capture", async () => {
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => result.current.clearAnnotations());
    expect(screenAnnotationClear).toHaveBeenCalledTimes(1);
    expect(screenAnnotationEnd).not.toHaveBeenCalled();
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);
  });

  it("stops and revokes markers when refreshed sources lose the shared display", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    vi.mocked(screenCaptureListSources).mockResolvedValueOnce([
      { id: 2, name: "Display 2", width: 1920, height: 1080 },
    ]);
    await act(async () => result.current.refreshSources());
    expect(result.current.active).toBe(false);
    expect(result.current.sourceId).toBe(2);
    expect(result.current.error).toContain("no longer available");
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("uses a new lease for a new display after stopping, even with identical pixels", async () => {
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, name: "Display 1", width: 1920, height: 1080 },
      { id: 2, name: "Display 2", width: 1920, height: 1080 },
    ]);
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    const firstShareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    act(() => result.current.setSourceId(2));
    expect(result.current.sourceId).toBe(1);
    act(() => result.current.stop());
    act(() => result.current.setSourceId(2));
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      frameId: "frame-2",
      sourceId: 2,
      sourceName: "Display 2",
    });
    await act(async () => result.current.start());
    const secondShareId = vi.mocked(screenAnnotationBegin).mock.calls[1][0];
    expect(secondShareId).not.toBe(firstShareId);
    expect(screenAnnotationBegin).toHaveBeenLastCalledWith(secondShareId, 2, "document-1");
    expect(screenCaptureFrame).toHaveBeenLastCalledWith(2, secondShareId);
    expect(share).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenLastCalledWith(
      expect.objectContaining({ frameId: "frame-2", source: "Display 2" }),
      expect.any(AbortSignal),
    );
  });

  it("revokes markers on loss of availability and ignores late capture success", async () => {
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(pending.promise);
    const { result, rerender, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    const shareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    rerender({ ownerKey: "main:thread:active", available: false });
    expect(screenAnnotationEnd).toHaveBeenCalledWith(shareId);
    await act(async () => pending.resolve(frame));
    expect(result.current.active).toBe(false);
    expect(share).not.toHaveBeenCalled();
  });

  it("caches the native document ID across sharing leases in the same JS document", async () => {
    const first = setup();
    await act(async () => first.result.current.refreshSources());
    await act(async () => first.result.current.start());
    first.unmount();
    vi.mocked(screenAnnotationDocument).mockResolvedValue("newer-native-document");
    const second = setup();
    await act(async () => second.result.current.refreshSources());
    await act(async () => second.result.current.start());
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(1);
    expect(screenAnnotationBegin).toHaveBeenLastCalledWith(expect.any(String), 1, "document-1");
  });

  it("keeps the old document epoch while permission is pending", async () => {
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValueOnce(permission.promise);
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(1);
    expect(screenCaptureRequestPermission).toHaveBeenCalledTimes(1);
    expect(vi.mocked(screenAnnotationDocument).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(screenCaptureRequestPermission).mock.invocationCallOrder[0],
    );
    vi.mocked(screenAnnotationDocument).mockResolvedValue("after-reload");
    vi.mocked(screenAnnotationBegin).mockRejectedValueOnce(new Error("Document has reloaded"));
    await act(async () => {
      permission.resolve(true);
      await starting;
    });
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(1);
    expect(screenAnnotationBegin).toHaveBeenCalledWith(expect.any(String), 1, "document-1");
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("Document has reloaded");
  });

  it("retries a failed document lookup on the next Start without requesting permission early", async () => {
    vi.mocked(screenAnnotationDocument).mockRejectedValueOnce(new Error("Document unavailable"));
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    expect(result.current.error).toContain("Document unavailable");
    expect(screenCaptureRequestPermission).not.toHaveBeenCalled();
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    await act(async () => result.current.start());
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(2);
    expect(screenAnnotationBegin).toHaveBeenCalledWith(expect.any(String), 1, "document-1");
    expect(result.current.active).toBe(true);
  });
});

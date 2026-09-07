import { LogicalSize, PhysicalSize } from "@tauri-apps/api/window";
import { describe, expect, it, vi } from "vitest";
import {
  createNativeWindowLayoutApplier,
  enqueueNativeWindowMutation,
  resolveWindowAspectRatioStrategy,
} from "./view-mode-native-window";

function mockWindow(fullscreen = false, maximized = false) {
  let size = new PhysicalSize(1200, 800);
  return {
    innerSize: vi.fn(async () => size),
    scaleFactor: vi.fn(async () => 1),
    isFullscreen: vi.fn(async () => fullscreen),
    setFullscreen: vi.fn(async (value: boolean) => {
      fullscreen = value;
    }),
    isMaximized: vi.fn(async () => maximized),
    maximize: vi.fn(async () => {
      maximized = true;
    }),
    unmaximize: vi.fn(async () => {
      maximized = false;
    }),
    setMinSize: vi.fn(async () => {}),
    setSize: vi.fn(async (value: LogicalSize) => {
      size = new PhysicalSize(value.width, value.height);
    }),
    setAlwaysOnTop: vi.fn(async () => {}),
  };
}

describe("View Mode native window layout", () => {
  it.each([
    [200, 300],
    [280, 560],
  ])("waits for fullscreen exit before applying compact size %ix%i", async (width, height) => {
    const window = mockWindow(true);
    let finishExit!: () => void;
    const exitFullscreen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishExit = resolve;
        }),
    );
    const apply = createNativeWindowLayoutApplier(window, exitFullscreen);
    const pending = apply({ window: { width, height } });
    await vi.waitFor(() => expect(exitFullscreen).toHaveBeenCalledOnce());
    expect(window.setSize).not.toHaveBeenCalled();
    expect(window.setMinSize).not.toHaveBeenCalled();
    finishExit();
    await pending;
    expect(window.setSize).toHaveBeenCalledWith(new LogicalSize(width, height));
    expect(window.setFullscreen).not.toHaveBeenCalled();
  });

  it("unmaximizes before sizing and restores normal size and maximization on exit", async () => {
    const window = mockWindow(false, true);
    const apply = createNativeWindowLayoutApplier(window, async () => {});
    await apply({ window: { width: 200, height: 300 } });
    expect(window.unmaximize).toHaveBeenCalledOnce();
    expect(window.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(
      window.setSize.mock.invocationCallOrder[0],
    );
    await apply({ window: { width: 280, height: 560 } });
    await apply(null);
    expect(window.setSize).toHaveBeenLastCalledWith(new LogicalSize(1200, 800));
    expect(window.maximize).toHaveBeenCalledOnce();
  });

  it("restores initial fullscreen after leaving compact mode", async () => {
    const window = mockWindow(true);
    const apply = createNativeWindowLayoutApplier(window, async () => {});
    await apply({ window: { width: 200, height: 300 } });
    expect(window.setFullscreen).not.toHaveBeenCalled();
    await apply(null);
    expect(window.setFullscreen).toHaveBeenCalledWith(true);
  });

  it("preserves fullscreen for unsized layouts and honors explicit fullscreen requests", async () => {
    const window = mockWindow(true);
    const exitFullscreen = vi.fn(async () => {});
    const apply = createNativeWindowLayoutApplier(window, exitFullscreen);
    await apply({ chrome: { visible: false } });
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(window.setFullscreen).toHaveBeenCalledWith(true);
    await apply({ window: { fullscreen: false } });
    expect(exitFullscreen).toHaveBeenCalledOnce();
    await apply({ window: { fullscreen: true, width: 200, height: 300 } });
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(window.setSize).not.toHaveBeenCalled();
    expect(window.setFullscreen).toHaveBeenCalledTimes(2);
  });

  it("does not resize when native fullscreen exit fails", async () => {
    const window = mockWindow(true);
    const apply = createNativeWindowLayoutApplier(window, async () => {
      throw new Error("fullscreen transition timed out");
    });
    await expect(apply({ window: { width: 200, height: 300 } })).rejects.toThrow("timed out");
    expect(window.setSize).not.toHaveBeenCalled();
    expect(window.setMinSize).not.toHaveBeenCalled();
  });
});

describe("View Mode native window aspect ratio", () => {
  it("disables aspect enforcement on macOS for resize stability", () => {
    expect(resolveWindowAspectRatioStrategy(2 / 3, true)).toEqual({
      nativeAspectRatio: null,
      jsAspectRatio: null,
    });
    expect(resolveWindowAspectRatioStrategy(undefined, true)).toEqual({
      nativeAspectRatio: null,
      jsAspectRatio: null,
    });
  });

  it("also avoids resize correction loops on other platforms", () => {
    expect(resolveWindowAspectRatioStrategy(2 / 3, false)).toEqual({
      nativeAspectRatio: null,
      jsAspectRatio: null,
    });
  });

  it("serializes window mutations and continues after a failure", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueueNativeWindowMutation(
      () =>
        new Promise<void>((_resolve, reject) => {
          events.push("first:start");
          releaseFirst = () => {
            events.push("first:end");
            reject(new Error("expected"));
          };
        }),
    );
    const second = enqueueNativeWindowMutation(async () => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("expected");
    await second;
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ScreenPointerSetting,
  screenAnnotationDocument,
  screenAnnotationSetEnabled,
} from "../../bindings/tauri-commands";

vi.mock("../../bindings/tauri-commands", () => ({
  screenAnnotationDocument: vi.fn(),
  screenAnnotationSetEnabled: vi.fn(),
}));

let useScreenPointerSettings: typeof import("./use-screen-pointer-settings").useScreenPointerSettings;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  ({ useScreenPointerSettings } = await import("./use-screen-pointer-settings"));
  vi.mocked(screenAnnotationDocument).mockResolvedValue("document-1");
  vi.mocked(screenAnnotationSetEnabled).mockImplementation(async (_document, _revision, value) => ({
    enabled: value,
    pointerEpoch: 7,
  }));
});
afterEach(cleanup);

function setup(initialEnabled: boolean | null = true) {
  const persist = vi.fn(async (_enabled: boolean) => {});
  const notify = vi.fn(async (_enabled: boolean, _pointerEpoch?: number) => {});
  const hook = renderHook(
    ({ initialEnabled }: { initialEnabled: boolean | null }) =>
      useScreenPointerSettings({ initialEnabled, persist, notify }),
    { initialProps: { initialEnabled } },
  );
  return { ...hook, persist, notify };
}

describe("independent screen pointer settings", () => {
  it("notifies a fresh native epoch after a rapid OFF/ON even when OFF acknowledgment is obsolete", async () => {
    const { result, notify } = setup(true);
    await act(async () => {});
    expect(notify).toHaveBeenCalledExactlyOnceWith(true, 7);
    notify.mockClear();
    const old = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ enabled: true, pointerEpoch: 9 });
    let off!: Promise<void>;
    await act(async () => {
      off = result.current.setEnabled(false);
    });
    await act(async () => result.current.setEnabled(true));
    await act(async () => {
      old.resolve({ enabled: false, pointerEpoch: 8 });
      await off;
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith(true, 9);
    expect(result.current.enabled).toBe(true);
  });

  it("completes initial synchronization after StrictMode effect replay", async () => {
    const notify = vi.fn(async () => {});
    const persist = vi.fn(async () => {});
    const { result } = renderHook(
      () => useScreenPointerSettings({ initialEnabled: false, notify, persist }),
      { wrapper: StrictMode },
    );
    await act(async () => {});
    expect(result.current.ready).toBe(true);
    expect(result.current.enabled).toBe(false);
    expect(notify).toHaveBeenCalledExactlyOnceWith(false, 7);
    expect(persist).not.toHaveBeenCalled();
  });

  it("retries failed initialization using saved OFF and coalesces pending retries", async () => {
    vi.mocked(screenAnnotationSetEnabled).mockRejectedValueOnce(new Error("Native unavailable"));
    const { result, persist } = setup(false);
    await act(async () => {});
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toContain("Could not update");
    const pending = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled).mockReturnValueOnce(pending.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.retry();
      second = result.current.retry();
    });
    expect(first).toBe(second);
    expect(screenAnnotationSetEnabled).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve({ enabled: false, pointerEpoch: 7 });
      await first;
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.enabled).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not let delayed old persistence failures replace current state", async () => {
    const { result, persist } = setup();
    await act(async () => {});
    const old = deferred<void>();
    persist.mockReturnValueOnce(old.promise);
    await act(async () => result.current.setEnabled(false));
    await act(async () => result.current.setEnabled(true));
    await act(async () => old.reject(new Error("Old save failed")));
    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it("waits for saved OFF and native acknowledgement before becoming ready", async () => {
    const native = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled).mockReturnValueOnce(native.promise);
    const { result, rerender, notify, persist } = setup(null);
    await act(async () => result.current.setEnabled(true));
    expect(screenAnnotationDocument).not.toHaveBeenCalled();
    expect(screenAnnotationSetEnabled).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    await act(async () => rerender({ initialEnabled: false }));
    expect(screenAnnotationSetEnabled).toHaveBeenCalledExactlyOnceWith("document-1", 1, false);
    expect(result.current.ready).toBe(false);
    expect(result.current.enabled).toBe(false);
    await act(async () => native.resolve({ enabled: false, pointerEpoch: 7 }));
    expect(result.current.ready).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith(false, 7);
    expect(persist).not.toHaveBeenCalled();
  });

  it("applies OFF without waiting for model notification or a slow config write", async () => {
    const { result, notify, persist } = setup();
    await act(async () => {});
    notify.mockClear();
    notify.mockReturnValue(new Promise(() => {}));
    persist.mockReturnValue(new Promise(() => {}));
    await act(async () => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.ready).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith(false, 7);
    expect(persist).toHaveBeenCalledExactlyOnceWith(false);
    await act(async () => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(persist.mock.calls).toEqual([[false], [true]]);
  });

  it("keeps the latest intent when native ON and OFF replies arrive in reverse order", async () => {
    const { result, notify, persist } = setup(false);
    await act(async () => {});
    notify.mockClear();
    const enabling = deferred<ScreenPointerSetting>();
    const disabling = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled)
      .mockReturnValueOnce(enabling.promise)
      .mockReturnValueOnce(disabling.promise);
    let on!: Promise<void>;
    let off!: Promise<void>;
    await act(async () => {
      on = result.current.setEnabled(true);
    });
    await act(async () => {
      off = result.current.setEnabled(false);
    });
    const calls = vi.mocked(screenAnnotationSetEnabled).mock.calls;
    expect(calls[2][1]).toBeGreaterThan(calls[1][1]);
    await act(async () => {
      disabling.resolve({ enabled: false, pointerEpoch: 7 });
      await off;
    });
    await act(async () => {
      enabling.resolve({ enabled: true, pointerEpoch: 6 });
      await on;
    });
    expect(result.current.enabled).toBe(false);
    expect(notify).toHaveBeenCalledExactlyOnceWith(false, 7);
    expect(persist).toHaveBeenCalledExactlyOnceWith(false);
    expect(result.current.error).toBeUndefined();
  });

  it("ignores a rejected old update after a newer update succeeds", async () => {
    const { result, persist } = setup();
    await act(async () => {});
    const old = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.setEnabled(false);
    });
    await act(async () => result.current.setEnabled(true));
    await act(async () => {
      old.reject(new Error("Stale revision"));
      await pending;
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBeUndefined();
    expect(persist).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("retains monotonic document revisions across remounts and discards late side effects", async () => {
    const old = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled).mockReturnValueOnce(old.promise);
    const first = setup(true);
    await act(async () => {});
    first.unmount();
    const second = setup(false);
    await act(async () => {});
    const calls = vi.mocked(screenAnnotationSetEnabled).mock.calls;
    expect(calls[1][1]).toBeGreaterThan(calls[0][1]);
    expect(screenAnnotationDocument).toHaveBeenCalledOnce();
    await act(async () => old.resolve({ enabled: true, pointerEpoch: 6 }));
    expect(first.notify).not.toHaveBeenCalled();
    expect(first.persist).not.toHaveBeenCalled();
    expect(second.result.current.enabled).toBe(false);
    expect(second.notify).toHaveBeenCalledExactlyOnceWith(false, 7);
  });

  it("keeps the last accepted state when native rejects the latest request", async () => {
    const { result, notify, persist } = setup();
    await act(async () => {});
    notify.mockClear();
    vi.mocked(screenAnnotationSetEnabled).mockRejectedValueOnce(new Error("Native failed"));
    await act(async () => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toContain("Could not update");
    expect(notify).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("leaves runtime OFF applied when persistence fails", async () => {
    const { result, persist } = setup();
    await act(async () => {});
    persist.mockRejectedValueOnce(new Error("Disk write failed"));
    await act(async () => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toContain("could not be saved");
  });
});

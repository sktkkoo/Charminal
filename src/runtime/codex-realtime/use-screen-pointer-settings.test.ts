// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ScreenPointerSetting,
  screenAnnotationDocument,
  screenAnnotationSetEnabled,
} from "../../bindings/tauri-commands";
import { readYorishiroConfigText } from "../user-pack-loader/yorishiro-io";

vi.mock("../../bindings/tauri-commands", () => ({
  screenAnnotationDocument: vi.fn(),
  screenAnnotationSetEnabled: vi.fn(),
}));
vi.mock("../user-pack-loader/yorishiro-io", () => ({
  readYorishiroConfigText: vi.fn(),
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
  vi.mocked(readYorishiroConfigText).mockResolvedValue("{}");
  vi.mocked(screenAnnotationDocument).mockResolvedValue("document-1");
  vi.mocked(screenAnnotationSetEnabled).mockImplementation(async (_document, _revision, value) => ({
    enabled: value,
    pointerEpoch: 7,
  }));
});
afterEach(cleanup);

function setup(savedEnabled = true) {
  vi.mocked(readYorishiroConfigText).mockResolvedValue(
    JSON.stringify({ screenPointersEnabled: savedEnabled }),
  );
  const persist = vi.fn(async (_enabled: boolean) => {});
  const notify = vi.fn(async (_enabled: boolean, _pointerEpoch?: number) => {});
  const hook = renderHook(() => useScreenPointerSettings({ persist, notify }));
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
    vi.mocked(readYorishiroConfigText).mockResolvedValue('{"screenPointersEnabled":false}');
    const { result } = renderHook(() => useScreenPointerSettings({ notify, persist }), {
      wrapper: StrictMode,
    });
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
    const config = deferred<string>();
    vi.mocked(readYorishiroConfigText).mockReturnValueOnce(config.promise);
    const native = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled).mockReturnValueOnce(native.promise);
    const { result, notify, persist } = setup();
    await act(async () => result.current.setEnabled(true));
    expect(screenAnnotationDocument).not.toHaveBeenCalled();
    expect(screenAnnotationSetEnabled).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    await act(async () => config.resolve('{"screenPointersEnabled":false}'));
    expect(screenAnnotationSetEnabled).toHaveBeenCalledExactlyOnceWith(
      "document-1",
      expect.any(Number),
      false,
    );
    expect(result.current.ready).toBe(false);
    expect(result.current.enabled).toBe(false);
    await act(async () => native.resolve({ enabled: false, pointerEpoch: 7 }));
    expect(result.current.ready).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith(false, 7);
    expect(persist).not.toHaveBeenCalled();
  });

  it("initializes a remounted App after the original config reader has unmounted", async () => {
    const config = deferred<string>();
    vi.mocked(readYorishiroConfigText).mockReturnValueOnce(config.promise);
    const first = setup();
    first.unmount();
    const second = setup();
    expect(second.result.current.ready).toBe(false);
    await act(async () => config.resolve('{"screenPointersEnabled":false}'));
    expect(readYorishiroConfigText).toHaveBeenCalledOnce();
    expect(first.notify).not.toHaveBeenCalled();
    expect(second.result.current.ready).toBe(true);
    expect(second.result.current.enabled).toBe(false);
    expect(second.notify).toHaveBeenCalledExactlyOnceWith(false, 7);
  });

  it("preserves accepted OFF across App remounts while its config write is pending", async () => {
    const first = setup(true);
    await act(async () => {});
    first.persist.mockReturnValue(new Promise(() => {}));
    await act(async () => first.result.current.setEnabled(false));
    first.unmount();
    // Disk still has ON. A new App must keep the user's accepted OFF intent.
    const second = setup(true);
    await act(async () => {});
    expect(readYorishiroConfigText).toHaveBeenCalledOnce();
    expect(second.result.current.ready).toBe(true);
    expect(second.result.current.enabled).toBe(false);
    expect(second.notify).toHaveBeenCalledExactlyOnceWith(false, 7);
    expect(second.persist).not.toHaveBeenCalled();
  });

  it.each([
    "before",
    "after",
  ])("keeps an in-flight OFF when its old native reply arrives %s the remount reply", async (order) => {
    const first = setup(true);
    await act(async () => {});
    const oldOff = deferred<ScreenPointerSetting>();
    const remounted = deferred<ScreenPointerSetting>();
    vi.mocked(screenAnnotationSetEnabled)
      .mockReturnValueOnce(oldOff.promise)
      .mockReturnValueOnce(remounted.promise);
    let off!: Promise<void>;
    await act(async () => {
      off = first.result.current.setEnabled(false);
    });
    first.unmount();
    const second = setup(true);
    await act(async () => {});
    expect(vi.mocked(screenAnnotationSetEnabled).mock.calls.map((call) => call[2])).toEqual([
      true,
      false,
      false,
    ]);
    await act(async () => {
      const accepted = { enabled: false, pointerEpoch: 8 };
      if (order === "before") {
        oldOff.resolve(accepted);
        await off;
        remounted.resolve(accepted);
      } else {
        remounted.resolve(accepted);
        await Promise.resolve();
        oldOff.resolve(accepted);
        await off;
      }
    });
    expect(second.result.current.ready).toBe(true);
    expect(second.result.current.enabled).toBe(false);
    expect([...first.persist.mock.calls, ...second.persist.mock.calls]).toEqual([[false]]);
    expect(second.notify).toHaveBeenCalledExactlyOnceWith(false, 8);
  });

  it("can retry a failed configuration read instead of leaving controls pending", async () => {
    vi.mocked(readYorishiroConfigText).mockRejectedValueOnce(new Error("Read failed"));
    const { result } = setup(false);
    await act(async () => {});
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toContain("Could not read");
    expect(screenAnnotationSetEnabled).not.toHaveBeenCalled();
    await act(async () => result.current.retry());
    expect(result.current.ready).toBe(true);
    expect(result.current.enabled).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it("saves a remounted App's OFF after an older App's delayed ON write", async () => {
    const { enqueueConfigWrite } = await import("../user-pack-loader/config-write-queue");
    let disk = { screenPointersEnabled: false, voiceVolume: 1 };
    const oldWrite = deferred<void>();
    const saved: Promise<void>[] = [];
    const first = setup(false);
    await act(async () => {});
    first.persist.mockImplementation((enabled) => {
      const write = enqueueConfigWrite(async () => {
        const snapshot = { ...disk, screenPointersEnabled: enabled };
        await oldWrite.promise;
        disk = snapshot;
      });
      saved.push(write);
      return write;
    });
    await act(async () => first.result.current.setEnabled(true));
    first.unmount();
    const second = setup(false);
    await act(async () => {});
    second.persist.mockImplementation((enabled) => {
      const write = enqueueConfigWrite(async () => {
        disk = { ...disk, screenPointersEnabled: enabled };
      });
      saved.push(write);
      return write;
    });
    await act(async () => second.result.current.setEnabled(false));
    // Other configuration updates still share the same read-modify-write queue.
    saved.push(
      enqueueConfigWrite(async () => {
        disk = { ...disk, voiceVolume: 0.5 };
      }),
    );
    await act(async () => {
      oldWrite.resolve();
      await Promise.all(saved);
    });
    expect(second.result.current.enabled).toBe(false);
    expect(disk).toEqual({ screenPointersEnabled: false, voiceVolume: 0.5 });
  });

  it("keeps native revisions and OFF when the settings module is hot replaced", async () => {
    const first = setup(true);
    await act(async () => {});
    await act(async () => first.result.current.setEnabled(false));
    const calls = vi.mocked(screenAnnotationSetEnabled).mock.calls;
    const previousRevision = calls[calls.length - 1][1];
    first.unmount();
    // Vite retains this service's hot.data while replacing the hook module.
    const hotData = await import("../hot-data");
    vi.doMock("../hot-data", () => hotData);
    try {
      vi.resetModules();
      ({ useScreenPointerSettings } = await import("./use-screen-pointer-settings"));
      vi.mocked(screenAnnotationSetEnabled).mockImplementation(
        async (_document, revision, value) => {
          if (revision <= previousRevision) throw new Error("Stale revision");
          return { enabled: value, pointerEpoch: 8 };
        },
      );
      const second = setup(true);
      await act(async () => {});
      expect(second.result.current.ready).toBe(true);
      expect(second.result.current.enabled).toBe(false);
      expect(readYorishiroConfigText).toHaveBeenCalledOnce();
      expect(second.notify).toHaveBeenCalledExactlyOnceWith(false, 8);
    } finally {
      vi.doUnmock("../hot-data");
    }
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

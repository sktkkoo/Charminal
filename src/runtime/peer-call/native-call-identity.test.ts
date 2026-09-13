import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeDescriptorStore } from "./call-identity";
import {
  loadNativeCallIdentity,
  type NativeCallDescriptor,
  type NativeCallIdentityPort,
  type NativeCallIdentityStore,
} from "./native-call-identity";

const endpoint = "wss://calls.example.test/v2/rooms";
const descriptor: NativeCallDescriptor = {
  identityId: "a".repeat(43),
  publicKey: `B${"a".repeat(86)}`,
};
function native(): NativeCallIdentityPort {
  return {
    prepare: vi.fn(async () => descriptor),
    authenticate: vi.fn(async () => ({
      type: "authenticate" as const,
      publicKey: descriptor.publicKey,
      signature: "a".repeat(86),
    })),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("native call identity", () => {
  it("pins public metadata before returning a usable identity and restores without creation", async () => {
    let reserved = false;
    let pinned: NativeCallDescriptor | null = null;
    const store: NativeCallIdentityStore = {
      reserve: vi.fn(async () => {
        const allowCreate = !reserved;
        reserved = true;
        return { allowCreate, descriptor: pinned };
      }),
      pin: vi.fn(async (_, value) => {
        pinned = value;
      }),
    };
    const port = native();
    const first = await loadNativeCallIdentity(endpoint, store, port);
    expect(store.pin).toHaveBeenCalledWith(endpoint, descriptor);
    expect(first.publicKey).toBe(descriptor.publicKey);
    await loadNativeCallIdentity(endpoint, store, port);
    expect(port.prepare).toHaveBeenNthCalledWith(1, endpoint, null, true);
    expect(port.prepare).toHaveBeenNthCalledWith(2, endpoint, descriptor.publicKey, false);
  });
  it("keeps interrupted reservations and refuses to expose an unpinned identity", async () => {
    const port = native();
    const store: NativeCallIdentityStore = {
      reserve: vi.fn(async () => ({ allowCreate: false, descriptor: null })),
      pin: vi.fn(async () => {
        throw new Error("storage failure");
      }),
    };
    await expect(loadNativeCallIdentity(endpoint, store, port)).rejects.toThrow("storage failure");
    expect(port.prepare).toHaveBeenCalledWith(endpoint, null, false);
    expect(port.authenticate).not.toHaveBeenCalled();
  });
  it("does not invoke native operations when legacy presence/read failure prevents reservation", async () => {
    const port = native();
    const store: NativeCallIdentityStore = {
      reserve: vi.fn(async () => {
        throw new Error("legacy identity retained");
      }),
      pin: vi.fn(),
    };
    await expect(loadNativeCallIdentity(endpoint, store, port)).rejects.toThrow(
      "legacy identity retained",
    );
    expect(port.prepare).not.toHaveBeenCalled();
    expect(store.pin).not.toHaveBeenCalled();
  });
  it("refuses a changed public pin and redacts unknown native errors", async () => {
    const port = native();
    const store: NativeCallIdentityStore = {
      reserve: vi.fn(async () => ({
        allowCreate: false,
        descriptor: { ...descriptor, identityId: "b".repeat(43) },
      })),
      pin: vi.fn(),
    };
    await expect(loadNativeCallIdentity(endpoint, store, port)).rejects.toMatchObject({
      stage: "native-key-mismatch",
    });
    expect(store.pin).not.toHaveBeenCalled();
    vi.mocked(port.prepare).mockRejectedValue("secret raw OS message");
    await expect(loadNativeCallIdentity(endpoint, store, port)).rejects.toMatchObject({
      stage: "native-unavailable",
      message: "通話の識別情報を準備できませんでした。",
    });
  });
  it("latches native signing failures instead of retrying OS access", async () => {
    const port = native();
    const store: NativeCallIdentityStore = {
      reserve: vi.fn(async () => ({ allowCreate: false, descriptor })),
      pin: vi.fn(),
    };
    vi.mocked(port.authenticate).mockRejectedValue("native-interaction-required");
    const identity = await loadNativeCallIdentity(endpoint, store, port);
    await expect(identity.authenticate("socket", "challenge")).rejects.toMatchObject({
      stage: "native-interaction-required",
    });
    await expect(identity.authenticate("socket", "challenge")).rejects.toMatchObject({
      stage: "native-interaction-required",
    });
    expect(port.authenticate).toHaveBeenCalledOnce();
  });
});

/** Minimal asynchronous IDB double: legacy get is a tripwire for CryptoKey deserialization. */
function metadataDatabase(legacyCount: number, failRead = false) {
  type Handler = (() => void) | null;
  const records = new Map<string, unknown>();
  const legacyGet = vi.fn(() => {
    throw new Error("must never deserialize CryptoKey");
  });
  const db = {
    onversionchange: null as Handler,
    close: vi.fn(),
    transaction: () => {
      let pending = 0;
      let aborted = false;
      const tx = {
        error: null as DOMException | null,
        oncomplete: null as Handler,
        onabort: null as Handler,
        onerror: null as Handler,
        abort: () => {
          aborted = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore: (name: string) =>
          name === "identities"
            ? {
                count: () =>
                  request(() => {
                    if (failRead) throw new DOMException("private storage error", "UnknownError");
                    return legacyCount;
                  }),
                get: legacyGet,
              }
            : {
                get: (key: string) => request(() => records.get(key)),
                add: (value: unknown, key: string) =>
                  request(() => {
                    records.set(key, value);
                  }),
                put: (value: unknown, key: string) =>
                  request(() => {
                    records.set(key, value);
                  }),
              },
      };
      function request(operation: () => unknown) {
        const result = { result: undefined as unknown, onsuccess: null as Handler };
        pending += 1;
        queueMicrotask(() => {
          if (aborted) return;
          try {
            result.result = operation();
            result.onsuccess?.();
          } catch (error) {
            tx.error = error as DOMException;
            tx.abort();
          }
          pending -= 1;
          if (!pending && !aborted) queueMicrotask(() => tx.oncomplete?.());
        });
        return result;
      }
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = { result: db, onsuccess: null as Handler };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return { records, legacyGet, close: () => db.onversionchange?.() };
}

describe("native identity metadata persistence", () => {
  it("uses count only for legacy presence and leaves legacy records untouched", async () => {
    const db = metadataDatabase(1);
    try {
      await expect(nativeDescriptorStore.reserve(endpoint)).rejects.toMatchObject({
        stage: "legacy-migration-required",
      });
      expect(db.records.size).toBe(0);
      expect(db.legacyGet).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
  it("does not treat a failed presence read as absence", async () => {
    const db = metadataDatabase(0, true);
    try {
      await expect(nativeDescriptorStore.reserve(endpoint)).rejects.toMatchObject({
        stage: "storage-read",
      });
      expect(db.records.size).toBe(0);
      expect(db.legacyGet).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
  it("persists reservation before generation and restores pins without granting create again", async () => {
    const db = metadataDatabase(0);
    try {
      expect(await nativeDescriptorStore.reserve(endpoint)).toEqual({
        allowCreate: true,
        descriptor: null,
      });
      expect(await nativeDescriptorStore.reserve(endpoint)).toEqual({
        allowCreate: false,
        descriptor: null,
      });
      await nativeDescriptorStore.pin(endpoint, descriptor);
      expect(await nativeDescriptorStore.reserve(endpoint)).toEqual({
        allowCreate: false,
        descriptor,
      });
      await expect(
        nativeDescriptorStore.pin(endpoint, { ...descriptor, publicKey: `B${"b".repeat(86)}` }),
      ).rejects.toMatchObject({ stage: "native-key-mismatch" });
      expect(db.legacyGet).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

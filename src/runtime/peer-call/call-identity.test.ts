import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallIdentityError,
  type CallIdentityStore,
  CallSocketAuthentication,
  callIdentityDiagnostic,
  callIdentityErrorMessage,
  getCallIdentity,
  managedInvitationRoom,
} from "./call-identity";

const endpoint = "wss://calls.example.test/v2/rooms";
const room = "10000000-0000-4000-8000-000000000001";
const challenge = "a".repeat(43);
const crypto = webcrypto as unknown as Crypto;
afterEach(() => vi.unstubAllGlobals());
function storage(records = new Map<string, CryptoKeyPair>()): CallIdentityStore {
  return {
    load: vi.fn(async (key) => records.get(key) ?? null),
    saveIfAbsent: vi.fn(async (key, keys) => {
      if (!records.has(key)) records.set(key, keys);
      return records.get(key) as CryptoKeyPair;
    }),
  };
}

describe("managed call device identity", () => {
  it("keeps one nonextractable key across concurrent loads and storage restoration, scoped by endpoint", async () => {
    const records = new Map<string, CryptoKeyPair>();
    const store = storage(records);
    const [first, same] = await Promise.all([
      getCallIdentity(endpoint, store, crypto),
      getCallIdentity(endpoint, store, crypto),
    ]);
    expect(first).toBe(same);
    expect(store.saveIfAbsent).toHaveBeenCalledOnce();
    const keys = records.get(endpoint) as CryptoKeyPair;
    expect(keys.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", keys.privateKey)).rejects.toThrow();
    const restored = await getCallIdentity(endpoint, storage(records), crypto);
    expect(restored.identityId).toBe(first.identityId);
    expect(restored.publicKey).toBe(first.publicKey);
    const different = await getCallIdentity("wss://other.example.test/v2/rooms", store, crypto);
    expect(different.identityId).not.toBe(first.identityId);
  });

  it("signs the exact room challenge context and refuses other endpoints or unrelated paths", async () => {
    const records = new Map<string, CryptoKeyPair>();
    const identity = await getCallIdentity(endpoint, storage(records), crypto);
    const reply = await identity.authenticate(`${endpoint}/${room}`, challenge);
    const signature = new Uint8Array(Buffer.from(reply.signature, "base64url"));
    const key = (records.get(endpoint) as CryptoKeyPair).publicKey;
    const data = `yorishiro-call-v2\n/v2/rooms/${room}\n${challenge}`;
    expect(signature.byteLength).toBe(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature,
        new TextEncoder().encode(data),
      ),
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature,
        new TextEncoder().encode(data.replace(room, identity.identityId)),
      ),
    ).toBe(false);
    await expect(
      identity.authenticate(`wss://other.example.test/v2/rooms/${room}`, challenge),
    ).rejects.toThrow();
    await expect(
      identity.authenticate("wss://calls.example.test/v2/users/another-person", challenge),
    ).rejects.toThrow();
    await expect(
      identity.authenticate(`${endpoint}/${room}?secret=bad`, challenge),
    ).rejects.toThrow();
    await expect(identity.authenticate(`${endpoint}/${room}`, "invalid")).rejects.toThrow();
  });

  it("rejects replayed challenges, early authentication and forged identities", async () => {
    const identity = await getCallIdentity(endpoint, storage(), crypto);
    const send = vi.fn();
    const authentication = new CallSocketAuthentication(identity, `${endpoint}/${room}`);
    await expect(
      authentication.receive({ type: "authenticated", identityId: identity.identityId }, send),
    ).rejects.toThrow();
    await authentication.receive({ type: "challenge", challenge }, send);
    expect(send).toHaveBeenCalledOnce();
    await expect(authentication.receive({ type: "challenge", challenge }, send)).rejects.toThrow();
    await expect(
      authentication.receive({ type: "authenticated", identityId: "x".repeat(43) }, send),
    ).rejects.toThrow();
    await authentication.receive({ type: "authenticated", identityId: identity.identityId }, send);
    expect(authentication.authenticated).toBe(true);
    await expect(
      authentication.receive({ type: "authenticated", identityId: identity.identityId }, send),
    ).rejects.toThrow();
  });

  it("does not replace corrupt persisted identities or invent an identity when storage fails", async () => {
    const store = storage(new Map([[endpoint, {} as CryptoKeyPair]]));
    await expect(getCallIdentity(endpoint, store, crypto)).rejects.toThrow();
    expect(store.saveIfAbsent).not.toHaveBeenCalled();
    const unavailable = storage();
    vi.mocked(unavailable.load).mockRejectedValue(new Error("storage unavailable"));
    await expect(getCallIdentity(endpoint, unavailable, crypto)).rejects.toThrow();
    expect(unavailable.saveIfAbsent).not.toHaveBeenCalled();
    expect(managedInvitationRoom(`yri2_${room}_${"a".repeat(22)}`)).toBe(room);
    expect(
      managedInvitationRoom(`https://calls.example.test/yri2_${room}_${"a".repeat(22)}`),
    ).toBeNull();
  });

  it("reports bounded preparation stages without exposing original errors or replacing identity", async () => {
    const privateDetail = "private key data and endpoint must not reach the UI";
    const unavailable = storage();
    vi.mocked(unavailable.load).mockRejectedValue(new DOMException(privateDetail, "SecurityError"));
    const readError = await getCallIdentity(endpoint, unavailable, crypto).catch((error) => error);
    expect(readError).toMatchObject({ stage: "storage-read", detail: "SecurityError" });
    expect(callIdentityErrorMessage(readError)).toBe(
      "通話の識別情報を準備できませんでした。 [identity:storage-read:SecurityError]",
    );
    expect(readError).not.toHaveProperty("cause");
    expect(readError.message).not.toContain(privateDetail);
    expect(unavailable.saveIfAbsent).not.toHaveBeenCalled();

    const missingCryptoStore = storage();
    await expect(getCallIdentity(endpoint, missingCryptoStore, {} as Crypto)).rejects.toMatchObject(
      {
        stage: "crypto-unavailable",
      },
    );
    expect(missingCryptoStore.load).not.toHaveBeenCalled();
    expect(missingCryptoStore.saveIfAbsent).not.toHaveBeenCalled();

    const corrupt = storage(new Map([[endpoint, {} as CryptoKeyPair]]));
    await expect(getCallIdentity(endpoint, corrupt, crypto)).rejects.toMatchObject({
      stage: "key-validate",
    });
    expect(corrupt.saveIfAbsent).not.toHaveBeenCalled();

    const untrusted = new Error(privateDetail);
    untrusted.name = privateDetail;
    expect(callIdentityErrorMessage(new CallIdentityError("storage-write", untrusted))).toBe(
      "通話の識別情報を準備できませんでした。 [identity:storage-write:UnknownError]",
    );
    expect(callIdentityErrorMessage(untrusted)).toBe("通話の識別情報を準備できませんでした。");
    expect(
      callIdentityDiagnostic(
        callIdentityErrorMessage(
          new CallIdentityError(
            "storage-write",
            new DOMException("private detail", "DataCloneError"),
          ),
        ),
      ),
    ).toBe(" [identity:storage-write:DataCloneError]");
    expect(callIdentityDiagnostic(" [identity:storage-write:private-detail]")).toBeNull();
    expect(callIdentityDiagnostic(" [identity:private-stage:DataCloneError]")).toBeNull();
  });

  it.each([
    ["generateKey", "key-generate"],
    ["exportKey", "public-export"],
    ["digest", "identity-digest"],
  ] as const)("identifies %s failures without returning a partially prepared identity", async (method, stage) => {
    const subtle = new Proxy(crypto.subtle, {
      get(target, property) {
        if (property === method)
          return () =>
            Promise.reject(new DOMException("sensitive provider detail", "OperationError"));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(getCallIdentity(endpoint, storage(), { subtle } as Crypto)).rejects.toMatchObject({
      stage,
      detail: "OperationError",
    });
  });

  it("rejects synchronous IndexedDB CryptoKey clone failure and aborts instead of accepting an unsaved key", async () => {
    type Handler = (() => void) | null;
    const add = vi.fn(() => {
      throw new DOMException("private key clone detail", "DataCloneError");
    });
    const abort = vi.fn();
    const db = {
      onversionchange: null as Handler,
      close: vi.fn(),
      transaction: (_store: string, mode: IDBTransactionMode) => {
        const request = {
          result: undefined,
          error: null,
          onsuccess: null as Handler,
          onerror: null as Handler,
        };
        const tx = {
          error: new DOMException("transaction aborted", "AbortError"),
          oncomplete: null as Handler,
          onabort: null as Handler,
          onerror: null as Handler,
          abort: () => {
            abort();
            queueMicrotask(() => tx.onabort?.());
          },
          objectStore: () => ({
            get: () => {
              queueMicrotask(() => {
                if (mode === "readonly") tx.oncomplete?.();
                else request.onsuccess?.();
              });
              return request;
            },
            add,
          }),
        };
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
    try {
      const error = await getCallIdentity(endpoint, undefined, crypto).catch((failure) => failure);
      expect(error).toBeInstanceOf(CallIdentityError);
      expect(error).toMatchObject({ stage: "storage-write", detail: "DataCloneError" });
      expect(callIdentityErrorMessage(error)).toBe(
        "通話の識別情報を準備できませんでした。 [identity:storage-write:DataCloneError]",
      );
      expect(add).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
      expect(error.message).not.toContain("private key clone detail");
    } finally {
      db.onversionchange?.();
    }
  });
});

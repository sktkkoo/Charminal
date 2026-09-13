import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type CallIdentityStore,
  CallSocketAuthentication,
  getCallIdentity,
  managedInvitationRoom,
} from "./call-identity";

const endpoint = "wss://calls.example.test/v2/rooms";
const room = "10000000-0000-4000-8000-000000000001";
const challenge = "a".repeat(43);
const crypto = webcrypto as unknown as Crypto;
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
});

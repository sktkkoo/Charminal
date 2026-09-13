import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallIdentity } from "./call-identity";
import { CallPresence } from "./call-presence";

const OWN = "o".repeat(43);
const REMOTE = "r".repeat(43);
const ROOM = "10000000-0000-4000-8000-000000000001";
const INVITATION = `yri2_${ROOM}_${"a".repeat(22)}`;
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  send = vi.fn((data: string) => this.sent.push(JSON.parse(data)));
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  receive(value: object) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const instances: CallPresence[] = [];
function fixture() {
  const sockets: Socket[] = [];
  const identity: CallIdentity = {
    identityId: OWN,
    publicKey: "public",
    authenticate: vi.fn(async () => ({
      type: "authenticate" as const,
      publicKey: "public",
      signature: "signature",
    })),
  };
  const onIncoming = vi.fn();
  const createSocket = vi.fn(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const presence = new CallPresence({
    endpoint: "wss://calls.example.test/v2/rooms",
    name: "Yori",
    onChange: vi.fn(),
    onIncoming,
    getIdentity: vi.fn(async () => identity),
    createWebSocket: createSocket,
  });
  instances.push(presence);
  return { presence, sockets, identity, onIncoming, createSocket };
}
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
async function online(f = fixture()) {
  await f.presence.start();
  const socket = f.sockets[0];
  socket.receive({ type: "challenge", challenge: "a".repeat(43) });
  socket.receive({ type: "authenticated", identityId: OWN });
  await flush();
  return { ...f, socket };
}
function incoming(socket: Socket, patch: Record<string, unknown> = {}) {
  socket.receive({
    type: "incoming",
    roomId: ROOM,
    identityId: REMOTE,
    name: "Mai",
    invitation: INVITATION,
    expiresAt: Date.now() + 45_000,
    ...patch,
  });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const item of instances.splice(0)) item.close();
  vi.useRealTimers();
});

describe("managed call presence", () => {
  it("authenticates before presence and takes an incoming invitation only after explicit Answer", async () => {
    const f = await online();
    expect(f.createSocket).toHaveBeenCalledWith(
      `wss://calls.example.test/v2/users/${OWN}`,
      "yorishiro-call-v2",
    );
    expect(f.socket.sent.map((message) => message.type)).toEqual(["authenticate", "presence"]);
    expect(f.presence.state).toBe("online");
    incoming(f.socket);
    await flush();
    expect(f.onIncoming).toHaveBeenCalledOnce();
    expect(
      f.socket.sent.some((message) => message.type === "join" || message.type === "accept"),
    ).toBe(false);
    expect(f.presence.takeIncoming("wrong-room")).toBeNull();
    expect(f.presence.takeIncoming(ROOM)).toBe(INVITATION);
    f.presence.setPresence("Yori", true);
    expect(f.presence.incoming).toBeNull();
    expect(f.socket.sent.some((message) => message.type === "decline")).toBe(false);
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({
      type: "presence",
      name: "Yori",
      busy: true,
    });
    expect(f.presence.takeIncoming(ROOM)).toBeNull();
  });

  it("uses broker contacts, supports explicit removal and clears canceled or expired incoming calls", async () => {
    const f = await online();
    const contacts = [{ identityId: REMOTE, name: "Mai", lastAcceptedAt: Date.now() }];
    f.socket.receive({ type: "contacts", contacts });
    await flush();
    expect(f.presence.contacts).toEqual(contacts);
    f.presence.removeContact("x".repeat(43));
    f.presence.removeContact(REMOTE);
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({
      type: "remove-contact",
      identityId: REMOTE,
    });
    expect(f.presence.contacts).toEqual(contacts);
    incoming(f.socket);
    await flush();
    f.socket.receive({ type: "incoming-ended", roomId: ROOM, reason: "cancelled" });
    await flush();
    expect(f.presence.takeIncoming(ROOM)).toBeNull();
    incoming(f.socket);
    await flush();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.presence.incoming).toBeNull();
    expect(f.presence.takeIncoming(ROOM)).toBeNull();
  });

  it("declines only the current request and clears it without media actions", async () => {
    const f = await online();
    incoming(f.socket);
    await flush();
    f.presence.decline("wrong");
    expect(f.presence.incoming).not.toBeNull();
    f.presence.decline(ROOM);
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({ type: "decline", roomId: ROOM });
    expect(f.presence.incoming).toBeNull();
  });

  it.each([
    "before-auth",
    "wrong-invitation",
    "duplicate-contacts",
  ])("closes malformed or unauthenticated metadata: %s", async (kind) => {
    const f = fixture();
    await f.presence.start();
    const socket = f.sockets[0];
    if (kind !== "before-auth") {
      socket.receive({ type: "challenge", challenge: "a".repeat(43) });
      socket.receive({ type: "authenticated", identityId: OWN });
      await flush();
    }
    if (kind === "wrong-invitation")
      incoming(socket, {
        invitation: `yri2_20000000-0000-4000-8000-000000000002_${"a".repeat(22)}`,
      });
    else {
      const entry = { identityId: REMOTE, name: "Mai", lastAcceptedAt: Date.now() };
      socket.receive({
        type: "contacts",
        contacts: kind === "duplicate-contacts" ? [entry, entry] : [entry],
      });
    }
    await flush();
    expect(f.presence.state).toBe("error");
    expect(f.presence.incoming).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("clears stale incoming on disconnect, reconnects a bounded number of times and stops on close", async () => {
    const f = await online();
    incoming(f.socket);
    await flush();
    f.socket.onclose?.();
    expect(f.presence.state).toBe("offline");
    expect(f.presence.incoming).toBeNull();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(Math.min(30_000, 1000 * 2 ** i));
      f.sockets[f.sockets.length - 1]?.onclose?.();
    }
    expect(f.presence.state).toBe("error");
    expect(f.sockets).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sockets).toHaveLength(7);
    f.presence.close();
    expect(f.presence.state).toBe("idle");
  });
});

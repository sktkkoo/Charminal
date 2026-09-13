import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallIdentity } from "./call-identity";
import type { CallPeer } from "./call-peer";
import { AudioProtocolVersionError } from "./peer-connection";
import {
  RoomSignaling,
  readManagedRoomIceServers,
  readRoomIceServers,
  validateRoomSignalingEndpoint,
} from "./room-signaling";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const HOST_ID = "10000000-0000-4000-8000-000000000002";
const GUEST_ID = "10000000-0000-4000-8000-000000000003";
const INVITE = "yri1_abcdefghijklmnopqrstuv";
const REQUEST_ID = "abcdefghijklmnop";
const rooms: RoomSignaling[] = [];

class Socket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  send = vi.fn((message: string) => this.sent.push(JSON.parse(message)));
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const HOST_IDENTITY = "h".repeat(43);
const GUEST_IDENTITY = "g".repeat(43);

function fixture(role: "host" | "guest" = "host", managed = false, targetIdentityId?: string) {
  const socket = new Socket();
  const listeners = new Set<() => void>();
  let peerClosed = false;
  const peer = {
    invite: vi.fn(async () => "opaque offer"),
    accept: vi.fn(async (_offer: string) => "opaque answer"),
    complete: vi.fn(async (_answer: string) => {}),
    close: vi.fn(() => {
      if (peerClosed) return;
      peerClosed = true;
      for (const listener of listeners) listener();
    }),
    onClose: vi.fn((listener: () => void) => listeners.add(listener)),
  };
  const factory = vi.fn(() => {
    if (!managed) expect(room.roomId).toBe(ROOM_ID);
    expect(room.localEndpointId).toBe(role === "host" ? HOST_ID : GUEST_ID);
    expect(room.remoteEndpointId).toBe(role === "host" ? GUEST_ID : HOST_ID);
    expect(room.remoteName).toBe(role === "host" ? "Guest AI" : "Host AI");
    return peer as unknown as CallPeer;
  });
  const createSocket = vi.fn(() => socket as unknown as WebSocket);
  const changed = vi.fn();
  const room = new RoomSignaling({
    endpoint: managed ? "wss://calls.example.test/v2/rooms" : "ws://127.0.0.1:1531/rooms",
    name: role === "host" ? "Host AI" : "Guest AI",
    createPeer: factory,
    createWebSocket: createSocket,
    onChange: changed,
    targetIdentityId,
    getIdentity: async () =>
      ({
        identityId: role === "host" ? HOST_IDENTITY : GUEST_IDENTITY,
        publicKey: "public",
        authenticate: async () => ({
          type: "authenticate",
          publicKey: "public",
          signature: "signature",
        }),
      }) as CallIdentity,
  });
  rooms.push(room);
  return { room, socket, peer, factory, createSocket, changed };
}

async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

async function hostStart(f = fixture()) {
  const creating = f.room.create();
  f.socket.open();
  f.socket.receive({
    type: "created",
    invitation: INVITE,
    expiresAt: Date.now() + 300_000,
    roomId: ROOM_ID,
    localEndpointId: HOST_ID,
  });
  await creating;
  await flush();
  return f;
}

async function hostRequest(f: ReturnType<typeof fixture>) {
  f.socket.receive({
    type: "request",
    requestId: REQUEST_ID,
    name: "Guest AI",
    endpointId: GUEST_ID,
  });
  await flush();
}

function admitted(
  f: ReturnType<typeof fixture>,
  role: "host" | "guest" = "host",
  iceServers: unknown = [],
) {
  f.socket.receive({
    type: "admitted",
    role,
    name: role === "host" ? "Guest AI" : "Host AI",
    roomId: ROOM_ID,
    localEndpointId: role === "host" ? HOST_ID : GUEST_ID,
    remoteEndpointId: role === "host" ? GUEST_ID : HOST_ID,
    iceServers,
  });
}

async function awaitingSignal(role: "host" | "guest") {
  const f = role === "host" ? await hostStart() : fixture("guest");
  if (role === "host") {
    await hostRequest(f);
    await f.room.accept();
  } else {
    const joining = f.room.join(INVITE);
    f.socket.open();
    f.socket.receive({
      type: "requested",
      hostName: "Host AI",
      expiresAt: Date.now() + 300_000,
      roomId: ROOM_ID,
      localEndpointId: GUEST_ID,
      remoteEndpointId: HOST_ID,
    });
    await joining;
  }
  admitted(f, role);
  await flush();
  return f;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const room of rooms.splice(0)) room.close();
  vi.useRealTimers();
});

async function managedStart(targetIdentityId?: string) {
  const f = fixture("host", true, targetIdentityId);
  const creating = f.room.create();
  await flush();
  f.socket.open();
  expect(f.socket.sent).toEqual([]);
  f.socket.receive({ type: "challenge", challenge: "a".repeat(43) });
  f.socket.receive({ type: "authenticated", identityId: HOST_IDENTITY });
  await flush();
  const invitation = `yri2_${f.room.roomId}_${"a".repeat(22)}`;
  f.socket.receive({
    type: "created",
    roomId: f.room.roomId,
    localEndpointId: HOST_ID,
    invitation,
    expiresAt: Date.now() + 45_000,
  });
  await creating;
  return { ...f, invitation };
}
async function managedRequest(f: ReturnType<typeof fixture>, identityId = GUEST_IDENTITY) {
  f.socket.receive({
    type: "request",
    requestId: REQUEST_ID,
    name: "Guest AI",
    endpointId: GUEST_ID,
    identityId,
  });
  await flush();
}
function managedAdmission(
  f: ReturnType<typeof fixture>,
  identityId = GUEST_IDENTITY,
  iceServers: unknown = [],
) {
  f.socket.receive({
    type: "admitted",
    role: "host",
    roomId: f.room.roomId,
    name: "Guest AI",
    localEndpointId: HOST_ID,
    remoteEndpointId: GUEST_ID,
    identityId,
    iceServers,
  });
}

describe("managed authenticated rooms", () => {
  it.each([
    "disconnected",
    "left",
  ])("handles managed %s as a normal peer exit and releases media", async (reason) => {
    const f = await managedStart(GUEST_IDENTITY);
    await managedRequest(f);
    managedAdmission(f);
    await flush();
    expect(f.factory).toHaveBeenCalledOnce();
    f.socket.receive({ type: "closed", reason });
    expect(f.room.closed).toBe(true);
    expect(f.room.error).toBe("相手がルームを退出しました。");
    expect(f.peer.close).toHaveBeenCalledOnce();
  });

  it("authenticates and creates a targeted room, autoaccepts only its verified counterpart, and waits for admission before media", async () => {
    const f = await managedStart(GUEST_IDENTITY);
    expect(f.createSocket).toHaveBeenCalledWith(
      `wss://calls.example.test/v2/rooms/${f.room.roomId}`,
      "yorishiro-call-v2",
    );
    expect(f.socket.sent).toEqual([
      { type: "authenticate", publicKey: "public", signature: "signature" },
      { type: "create", name: "Host AI", targetIdentityId: GUEST_IDENTITY },
    ]);
    expect(f.room.invitation).toBe("");
    expect(f.factory).not.toHaveBeenCalled();
    await managedRequest(f);
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({
      type: "accept",
      requestId: REQUEST_ID,
    });
    expect(f.factory).not.toHaveBeenCalled();
    managedAdmission(f);
    await flush();
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.room.remoteIdentityId).toBe(GUEST_IDENTITY);
    expect(f.room.localIdentityId).toBe(HOST_IDENTITY);
  });

  it("requires manual acceptance for first invitations and refuses identity substitution at admission", async () => {
    const f = await managedStart();
    expect(f.room.invitation).toBe(f.invitation);
    await managedRequest(f);
    expect(f.room.state).toBe("pending");
    expect(f.socket.sent.some((entry) => entry.type === "accept")).toBe(false);
    await f.room.accept();
    managedAdmission(f, "x".repeat(43));
    await flush();
    expect(f.room.closed).toBe(true);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("rejects a same-name request from a different stable identity without autoaccept", async () => {
    const f = await managedStart(GUEST_IDENTITY);
    await managedRequest(f, "x".repeat(43));
    expect(f.room.closed).toBe(true);
    expect(f.socket.sent.some((entry) => entry.type === "accept")).toBe(false);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated room state and cross-protocol invitations", async () => {
    const f = fixture("host", true);
    const creating = f.room.create();
    const rejected = expect(creating).rejects.toThrow();
    await flush();
    f.socket.open();
    f.socket.receive({
      type: "created",
      roomId: f.room.roomId,
      localEndpointId: HOST_ID,
      invitation: `yri2_${f.room.roomId}_${"a".repeat(22)}`,
      expiresAt: Date.now() + 45_000,
    });
    await rejected;
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.socket.sent.some((entry) => entry.type === "create")).toBe(false);
    const legacy = fixture("guest");
    await expect(legacy.room.join(`yri2_${ROOM_ID}_${"a".repeat(22)}`)).rejects.toThrow();
    expect(legacy.createSocket).not.toHaveBeenCalled();
    const modern = fixture("guest", true);
    await expect(modern.room.join(INVITE)).rejects.toThrow();
    expect(modern.createSocket).not.toHaveBeenCalled();
  });

  it("joins the room in an accepted v2 invitation and binds admitted identity to the requested host", async () => {
    const f = fixture("guest", true);
    const invitation = `yri2_${ROOM_ID}_${"a".repeat(22)}`;
    const joining = f.room.join(invitation);
    await flush();
    f.socket.open();
    f.socket.receive({ type: "challenge", challenge: "a".repeat(43) });
    f.socket.receive({ type: "authenticated", identityId: GUEST_IDENTITY });
    await flush();
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({
      type: "join",
      name: "Guest AI",
      invitation,
    });
    f.socket.receive({
      type: "requested",
      roomId: ROOM_ID,
      localEndpointId: GUEST_ID,
      remoteEndpointId: HOST_ID,
      identityId: HOST_IDENTITY,
      hostName: "Host AI",
      expiresAt: Date.now() + 45_000,
    });
    await joining;
    expect(f.factory).not.toHaveBeenCalled();
    f.socket.receive({
      type: "admitted",
      role: "guest",
      roomId: ROOM_ID,
      localEndpointId: GUEST_ID,
      remoteEndpointId: HOST_ID,
      identityId: HOST_IDENTITY,
      name: "Host AI",
      iceServers: [],
    });
    await flush();
    expect(f.factory).toHaveBeenCalledOnce();
  });

  it("separates managed provider validation from coturn credentials and rejects unapproved URLs", () => {
    const provider = [
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
        ],
        username: "provider-user",
        credential: "provider-secret",
      },
    ];
    expect(readManagedRoomIceServers(provider)).toEqual(provider);
    expect(readRoomIceServers(provider)).toBeNull();
    expect(
      readManagedRoomIceServers([{ ...provider[0], urls: ["turn:attacker.example:3478"] }]),
    ).toBeNull();
    expect(
      readManagedRoomIceServers([{ ...provider[0], credential: "private\nsecret" }]),
    ).toBeNull();
    expect(readManagedRoomIceServers([{ urls: ["stun:stun.cloudflare.com:3478"] }])).not.toBeNull();
  });

  it("accepts the managed provider's full five-route TURN response without dropping TCP fallbacks", () => {
    const iceServers = [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turn:turn.cloudflare.com:80?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "u".repeat(1024),
        credential: "provider-secret",
      },
    ];
    expect(readManagedRoomIceServers(iceServers)).toEqual(iceServers);
    expect(
      readManagedRoomIceServers([
        ...iceServers,
        ...iceServers,
        ...iceServers,
        ...iceServers,
        ...iceServers,
      ]),
    ).toBeNull();
  });
});

describe("room admission and automatic signaling", () => {
  it.each([
    "host",
    "guest",
  ] as const)("shows the fixed audio compatibility message when the %s rejects an incompatible signal", async (role) => {
    const f = await awaitingSignal(role);
    const error = new AudioProtocolVersionError();
    // Even the recognized local error's mutable message is not an output channel.
    error.message = "untrusted private SDP text";
    const receive = role === "host" ? f.peer.complete : f.peer.accept;
    receive.mockRejectedValueOnce(error);
    const kind = role === "host" ? "answer" : "offer";
    f.socket.receive({ type: "signal", kind, data: "incompatible opaque signal" });
    await flush();
    expect(f.room.error).toBe("音声分離に対応した同じ版で接続し直してください。");
    expect(f.room.closed).toBe(true);
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({ type: "leave" });
    expect(f.socket.sent.some((message) => message.type === "ready")).toBe(false);
    expect(f.room.error).not.toContain("private SDP");
  });

  it.each([
    new Error("untrusted private SDP text"),
    Object.assign(new Error("untrusted private SDP text"), { name: "AudioProtocolVersionError" }),
    { name: "AudioProtocolVersionError", message: "untrusted private SDP text" },
  ])("sanitizes generic or forged compatibility errors from negotiation: %j", async (error) => {
    const f = await awaitingSignal("host");
    f.peer.complete.mockRejectedValueOnce(error);
    f.socket.receive({ type: "signal", kind: "answer", data: "opaque answer" });
    await flush();
    expect(f.room.error).toBe("通話を準備できませんでした。新しいルームでお試しください。");
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.room.error).not.toContain("private SDP");
  });

  it("creates no media peer until admission, then exchanges the host offer and answer automatically", async () => {
    const f = await hostStart();
    expect(f.room.state).toBe("hosting");
    expect(f.room.invitation).toBe(INVITE);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.createSocket).toHaveBeenCalledWith("ws://127.0.0.1:1531/rooms", "yorishiro-room-v1");
    expect(f.socket.sent).toEqual([{ type: "create", name: "Host AI" }]);
    await hostRequest(f);
    expect(f.room.state).toBe("pending");
    expect(f.factory).not.toHaveBeenCalled();
    await f.room.accept();
    expect(f.factory).not.toHaveBeenCalled();
    admitted(f);
    await flush();
    expect(f.room.peer).toBe(f.peer);
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.room.invitation).toBe("");
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({
      type: "signal",
      kind: "offer",
      data: "opaque offer",
    });
    f.socket.receive({ type: "signal", kind: "answer", data: "opaque answer" });
    await flush();
    expect(f.peer.complete).toHaveBeenCalledWith("opaque answer");
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({ type: "ready" });
    f.socket.receive({ type: "active" });
    await flush();
    expect(f.room.state).toBe("active");
    f.peer.close();
    expect(f.room.closed).toBe(true);
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({ type: "leave" });
  });

  it("sends the invitation in a message and waits for host approval before preparing the guest", async () => {
    const f = fixture("guest");
    const joining = f.room.join(` ${INVITE} `);
    f.socket.open();
    expect(f.socket.sent).toEqual([{ type: "join", name: "Guest AI", invitation: INVITE }]);
    expect(f.createSocket.mock.calls[0]).not.toContain(INVITE);
    f.socket.receive({
      type: "requested",
      hostName: "Host AI",
      expiresAt: Date.now() + 300_000,
      roomId: ROOM_ID,
      localEndpointId: GUEST_ID,
      remoteEndpointId: HOST_ID,
    });
    await joining;
    expect(f.room.state).toBe("requesting");
    expect(f.factory).not.toHaveBeenCalled();
    admitted(f, "guest");
    await flush();
    expect(f.peer.invite).not.toHaveBeenCalled();
    f.socket.receive({ type: "signal", kind: "offer", data: "opaque offer" });
    await flush();
    expect(f.peer.accept).toHaveBeenCalledWith("opaque offer");
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({
      type: "signal",
      kind: "answer",
      data: "opaque answer",
    });
    f.socket.receive({ type: "active" });
    await flush();
    expect(f.room.state).toBe("active");
  });

  it("rejects without constructing a peer and keeps a waiting invitation after cancellation", async () => {
    const f = await hostStart();
    await hostRequest(f);
    await f.room.reject();
    expect(f.socket.sent[f.socket.sent.length - 1]).toEqual({
      type: "reject",
      requestId: REQUEST_ID,
    });
    f.socket.receive({ type: "request_cancelled", requestId: REQUEST_ID });
    await flush();
    expect(f.room.state).toBe("hosting");
    expect(f.room.invitation).toBe(INVITE);
    expect(f.room.pendingGuest).toBeNull();
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("closes media synchronously while an offer is still gathering and never sends the late offer", async () => {
    const f = await hostStart();
    let finishOffer: (offer: string) => void = () => {};
    f.peer.invite.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOffer = resolve;
        }),
    );
    await hostRequest(f);
    await f.room.accept();
    admitted(f);
    await flush();
    expect(f.peer.invite).toHaveBeenCalledOnce();
    f.socket.receive({ type: "closed", reason: "participant_left" });
    expect(f.room.closed).toBe(true);
    expect(f.peer.close).toHaveBeenCalledOnce();
    finishOffer("late private offer");
    await flush();
    expect(f.socket.sent.some((value) => value.type === "signal")).toBe(false);
  });

  it("prevents a replayed or unsolicited admission from creating another peer", async () => {
    const f = await hostStart();
    admitted(f);
    await flush();
    expect(f.room.closed).toBe(true);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("rejects mismatched admission identities and repeated host actions", async () => {
    const f = await hostStart();
    await hostRequest(f);
    await f.room.accept();
    await expect(f.room.accept()).rejects.toThrow();
    f.socket.receive({
      type: "admitted",
      role: "host",
      name: "Guest AI",
      roomId: ROOM_ID,
      localEndpointId: HOST_ID,
      remoteEndpointId: ROOM_ID,
      iceServers: [],
    });
    await flush();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.room.closed).toBe(true);
  });

  it("times out stalled creation and handles cancellation while opening", async () => {
    const stalled = fixture();
    const creating = stalled.room.create();
    const rejection = expect(creating).rejects.toThrow();
    vi.advanceTimersByTime(15_000);
    await rejection;
    expect(stalled.room.closed).toBe(true);
    const cancelled = fixture();
    const pending = cancelled.room.create();
    cancelled.room.close();
    await expect(pending).rejects.toThrow();
    cancelled.socket.open();
    expect(cancelled.socket.send).not.toHaveBeenCalled();
  });

  it("does not expose unknown server error values and bounds binary/oversized frames", async () => {
    const f = await hostStart();
    f.socket.receive({ type: "closed", reason: "__proto__" });
    expect(typeof f.room.error).toBe("string");
    const binary = await hostStart();
    binary.socket.onmessage?.({ data: new ArrayBuffer(8) });
    expect(binary.room.closed).toBe(true);
    const large = await hostStart();
    large.socket.onmessage?.({ data: "あ".repeat(100_000) });
    expect(large.room.closed).toBe(true);
  });

  it("rejects SDP and arbitrary links in the invitation field without opening a socket", async () => {
    const f = fixture("guest");
    await expect(f.room.join('{"signal":"private SDP"}')).rejects.toThrow();
    await expect(f.room.join(`https://example.com/#${INVITE}`)).rejects.toThrow();
    expect(f.createSocket).not.toHaveBeenCalled();
  });

  it("populates trusted ICE before peer creation, returns copies, and discards credentials on close", async () => {
    const f = await hostStart();
    expect(f.room.iceServers).toEqual([]);
    await hostRequest(f);
    await f.room.accept();
    expect(f.room.iceServers).toEqual([]);
    const iceServers = temporaryIce();
    f.factory.mockImplementationOnce(() => {
      expect(f.room.iceServers).toEqual(iceServers);
      return f.peer as unknown as CallPeer;
    });
    admitted(f, "host", iceServers);
    await flush();
    expect(f.factory).toHaveBeenCalledOnce();
    const copy = f.room.iceServers;
    copy[1].credential = "changed";
    (copy[0].urls as string[]).push("stun:other.example");
    expect(f.room.iceServers).toEqual(iceServers);
    expect(JSON.stringify(f.socket.sent)).not.toContain(iceServers[1].credential);
    f.room.close();
    expect(f.room.iceServers).toEqual([]);
  });

  it("rejects malformed or mismatched admission ICE without constructing a peer", async () => {
    for (const iceServers of [
      undefined,
      null,
      [{ urls: ["https://turn.example"] }],
      [
        {
          ...temporaryIce()[1],
          username: `${Math.floor(Date.now() / 1000) + 3600}:${ROOM_ID}:${GUEST_ID}`,
        },
      ],
    ]) {
      const f = await hostStart();
      await hostRequest(f);
      await f.room.accept();
      admitted(f, "host", iceServers === undefined ? "missing" : iceServers);
      await flush();
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.room.closed).toBe(true);
      expect(f.room.iceServers).toEqual([]);
    }
  });

  it("explains a duplicate resident name and prepares no media", async () => {
    const f = fixture("guest");
    const joining = f.room.join(INVITE);
    const failure = expect(joining).rejects.toThrow(
      "同じ名前の住人がいます。通話で使う名前を変えてください。",
    );
    f.socket.open();
    f.socket.receive({ type: "error", code: "duplicate_name" });
    await failure;
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.room.closed).toBe(true);
  });
});

function temporaryIce() {
  return [
    { urls: ["stun:stun.example:3478"] },
    {
      urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:5349?transport=tcp"],
      username: `${Math.floor(Date.now() / 1000) + 3600}:${ROOM_ID}:${HOST_ID}`,
      credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  ];
}

describe("broker ICE validation", () => {
  it("accepts an empty LAN configuration and bounded STUN/temporary TURN including IPv6", () => {
    expect(readRoomIceServers([])).toEqual([]);
    expect(readRoomIceServers(temporaryIce(), { roomId: ROOM_ID, endpointId: HOST_ID })).toEqual(
      temporaryIce(),
    );
    const stun = [{ urls: ["stun:[::1]:3478", "stuns:stun.example:5349"] }];
    expect(readRoomIceServers(stun)).toEqual(stun);
  });

  it("rejects extra fields, mixed schemes, malformed URLs, excess servers, and permanent credentials", () => {
    const turn = temporaryIce()[1];
    for (const ice of [
      null,
      {},
      [{ urls: "stun:stun.example" }],
      [...temporaryIce(), { urls: ["stun:third.example"] }],
      [{ urls: [] }],
      [{ urls: Array.from({ length: 5 }, (_, index) => `stun:host${index}.example`) }],
      [{ urls: ["stun:stun.example", "turn:turn.example"] }],
      [{ urls: ["stun:stun.example"], credential: "not-for-stun" }],
      [{ ...turn, sharedSecret: "not-allowed" }],
      [{ ...turn, credential: "permanent-password" }],
      [{ ...turn, username: "permanent-user" }],
      ...[
        "https://turn.example",
        "turn:user:password@turn.example",
        "turn:turn.example/path",
        "turn:turn.example?token=secret",
        "turn:turn.example:99999",
        "turn:turn.example:0",
        "stun:stun.example?transport=udp",
        `stun:${"a".repeat(257)}`,
      ].map((url) => [{ urls: [url] }]),
    ]) {
      expect(readRoomIceServers(ice)).toBeNull();
    }
  });

  it("rejects credentials with expired or excessive lifetime or the wrong admission identity", () => {
    const turn = temporaryIce()[1];
    for (const seconds of [-1, 60, 3700, 86400]) {
      expect(
        readRoomIceServers([
          { ...turn, username: `${Math.floor(Date.now() / 1000) + seconds}:${ROOM_ID}:${HOST_ID}` },
        ]),
      ).toBeNull();
    }
    expect(
      readRoomIceServers(temporaryIce(), { roomId: ROOM_ID, endpointId: GUEST_ID }),
    ).toBeNull();
  });
});

describe("signaling endpoint validation", () => {
  it.each([
    "wss://rooms.example.com/rooms",
    "ws://localhost:1531/rooms",
    "ws://127.0.0.1:1531/rooms",
    "ws://[::1]:1531/rooms",
    "ws://192.168.1.20:1531/rooms",
    "ws://172.16.0.2:1531/rooms",
    "ws://10.0.0.2:1531/rooms",
  ])("accepts TLS or explicit local development: %s", (endpoint) => {
    expect(validateRoomSignalingEndpoint(endpoint)).toBe(endpoint);
  });
  it.each([
    "",
    "ws://rooms.example.com/rooms",
    "ws://172.32.0.1/rooms",
    "https://rooms.example.com/rooms",
    "wss://user:password@rooms.example.com/rooms",
    "wss://rooms.example.com/rooms?token=secret",
    "wss://rooms.example.com/rooms#secret",
    "wss://rooms.example.com/other",
  ])("rejects insecure public or credential-bearing endpoints: %s", (endpoint) => {
    expect(() => validateRoomSignalingEndpoint(endpoint)).toThrow();
  });
});

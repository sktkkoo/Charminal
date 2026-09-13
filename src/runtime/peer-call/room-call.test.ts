import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarSizeLimitError } from "./avatar-transfer";
import { isIssuedCallAvatarUrl } from "./call-avatar-url";
import type { CallPeer } from "./call-peer";
import type { CallResidentIdentity, NativeAgentCallbacks } from "./native-agent";
import type { RoomSignalingOptions } from "./room-signaling";

interface PeerFake {
  state: string;
  closed: boolean;
  remote: { allowRemoteAi: boolean } | null;
  changed(): void;
  message?: (value: unknown) => void;
  asset?: (value: ArrayBuffer) => void;
  assetReady?: () => void;
  revoke?: () => void;
  sendMessage: ReturnType<typeof vi.fn>;
  setRemoteAiAllowed: ReturnType<typeof vi.fn>;
  setMicrophone: ReturnType<typeof vi.fn>;
  setOutput: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
interface AgentFake {
  identity: CallResidentIdentity;
  callbacks: NativeAgentCallbacks;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setInputEnabled: ReturnType<typeof vi.fn>;
  requestTurn: ReturnType<typeof vi.fn>;
}
interface SignalFake {
  options: RoomSignalingOptions;
  role: "host" | "guest";
  roomId: string;
  localEndpointId: string;
  remoteEndpointId: string;
  remoteName: string;
  close: ReturnType<typeof vi.fn>;
  closed: boolean;
}
interface TransferFake {
  accept: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  received?: (bytes: ArrayBuffer) => void;
}

const fakes = vi.hoisted(() => ({
  agents: [] as AgentFake[],
  peers: [] as PeerFake[],
  signals: [] as SignalFake[],
  transfers: [] as TransferFake[],
  throwConstructor: false,
  start: vi.fn(async () => {}),
  bytes: vi.fn(async () => new ArrayBuffer(12)),
}));

vi.mock("../three-runtime/three-runtime", () => ({
  getThreeRuntime: () => ({ getVrm: () => null }),
}));
vi.mock("../vrm-cache", () => ({ getVrmCache: () => ({ getBytes: fakes.bytes }) }));
vi.mock("./room-signaling", () => ({
  validateRoomSignalingEndpoint: (value: string) => value,
  RoomSignaling: class {
    closed = false;
    role: "host" | "guest" = "host";
    roomId = "room";
    localEndpointId = "host";
    remoteEndpointId = "guest";
    remoteName = "GPT";
    create = vi.fn(async () => {});
    join = vi.fn(async () => {});
    accept = vi.fn(async () => {});
    reject = vi.fn(async () => {});
    close = vi.fn(() => {
      this.closed = true;
      this.options.onChange();
    });
    constructor(readonly options: RoomSignalingOptions) {
      fakes.signals.push(this);
    }
  },
}));
vi.mock("./call-peer", () => ({
  CallPeer: class {
    state = "new";
    closed = false;
    remote: { allowRemoteAi: boolean } | null = null;
    connection = { sendAsset: vi.fn(() => true) };
    message?: (value: unknown) => void;
    asset?: (value: ArrayBuffer) => void;
    assetReady?: () => void;
    revoke?: () => void;
    closers = new Set<() => void>();
    setRemoteAiAllowed = vi.fn();
    setMicrophone = vi.fn(async () => {});
    setOutput = vi.fn(async () => {});
    sendMessage = vi.fn((_value: unknown) => true);
    close = vi.fn(() => {
      if (this.closed) return;
      this.closed = true;
      this.state = "closed";
      for (const listener of this.closers) listener();
      this.changed();
    });
    constructor(
      _name: string,
      _avatar: () => unknown,
      readonly changed: () => void,
    ) {
      fakes.peers.push(this);
    }
    onMessage(listener: (value: unknown) => void) {
      this.message = listener;
    }
    onAsset(listener: (value: ArrayBuffer) => void) {
      this.asset = listener;
    }
    onAssetReady(listener: () => void) {
      this.assetReady = listener;
    }
    onPermissionRevoked(listener: () => void) {
      this.revoke = listener;
    }
    onClose(listener: () => void) {
      this.closers.add(listener);
    }
  },
}));
vi.mock("./native-agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("./native-agent")>();
  return {
    ...original,
    NativeCallAgent: class {
      start = vi.fn(() => fakes.start());
      stop = vi.fn(() => {
        this.callbacks.activity?.("closed");
        this.callbacks.changed();
        this.callbacks.ended();
      });
      setInputEnabled = vi.fn();
      requestTurn = vi.fn(async (_text: string) => {});
      constructor(
        readonly identity: CallResidentIdentity,
        _peer: CallPeer,
        readonly callbacks: NativeAgentCallbacks,
      ) {
        if (fakes.throwConstructor) throw new Error("audio constructor failed");
        fakes.agents.push(this);
      }
    },
  };
});
vi.mock("./avatar-transfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./avatar-transfer")>()),
  AvatarTransfer: class {
    accept = vi.fn();
    send = vi.fn(async () => {});
    close = vi.fn();
    received?: (bytes: ArrayBuffer) => void;
    constructor() {
      fakes.transfers.push(this);
    }
    subscribe(listener: (bytes: ArrayBuffer) => void) {
      this.received = listener;
    }
  },
}));

import { RoomCall, type RoomCallOptions } from "./room-call";

const calls: RoomCall[] = [];
function fixture(
  role: "host" | "guest" = "host",
  avatarUrl?: string,
  extra: Partial<RoomCallOptions> = {},
) {
  const active = vi.fn();
  const changed = vi.fn();
  const call = new RoomCall({
    endpoint: "ws://127.0.0.1:1531/rooms",
    name: role === "host" ? "Yori" : "GPT",
    publicDescription: "Public character description",
    avatarUrl,
    onChange: changed,
    onActiveChange: active,
    ...extra,
  });
  calls.push(call);
  const signal = fakes.signals[fakes.signals.length - 1];
  signal.role = role;
  signal.localEndpointId = role;
  signal.remoteEndpointId = role === "host" ? "guest" : "host";
  signal.remoteName = role === "host" ? "GPT" : "Yori";
  return { call, signal, active, changed };
}
function admit(f: ReturnType<typeof fixture>) {
  f.signal.options.createPeer();
  f.signal.options.onChange();
  return fakes.peers[fakes.peers.length - 1];
}
function connect(peer: PeerFake, allowRemoteAi = true) {
  peer.state = "connected";
  peer.remote = { allowRemoteAi };
  peer.changed();
}
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
async function pair() {
  const host = fixture();
  const hostPeer = admit(host);
  const guest = fixture("guest");
  const guestPeer = admit(guest);
  hostPeer.sendMessage.mockImplementation((value) => {
    guestPeer.message?.(structuredClone(value));
    return true;
  });
  guestPeer.sendMessage.mockImplementation((value) => {
    hostPeer.message?.(structuredClone(value));
    return true;
  });
  connect(hostPeer);
  connect(guestPeer);
  await flush();
  expect(host.call.ready).toBe(true);
  expect(guest.call.ready).toBe(true);
  return {
    host,
    guest,
    hostPeer,
    guestPeer,
    hostAgent: fakes.agents[0],
    guestAgent: fakes.agents[1],
  };
}
function frame(sequence: number, fields: Record<string, unknown> = {}) {
  return {
    protocol: "yorishiro-room-audio",
    version: 1,
    roomId: "room",
    sender: "guest",
    sequence,
    epoch: { counter: 0, owner: "host", paused: false },
    ...fields,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fakes.peers = [];
  fakes.agents = [];
  fakes.signals = [];
  fakes.transfers = [];
  fakes.throwConstructor = false;
  fakes.start.mockReset().mockResolvedValue(undefined);
  fakes.bytes.mockReset().mockResolvedValue(new ArrayBuffer(12));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:remote-avatar");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  for (const call of calls.splice(0)) call.leave();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("admitted room lifecycle", () => {
  it("explains an oversize avatar without ending or pausing the voice call", async () => {
    const f = fixture("host", "avatar.vrm");
    const peer = admit(f);
    fakes.transfers[0].send.mockRejectedValue(new AvatarSizeLimitError(55 * 1024 * 1024));
    connect(peer);
    peer.assetReady?.();
    await flush();
    expect(f.call.error).toBe(
      "アバターは50 MiBまで共有できます（現在 55.00 MiB）。音声の会話は続けられます。",
    );
    expect(f.call.connected).toBe(true);
    expect(f.call.paused).toBe(false);
    expect(f.call.closed).toBe(false);
  });

  it("starts one local agent only after admission, media connection, and remote consent", async () => {
    const f = fixture();
    await f.call.create();
    expect(fakes.peers).toHaveLength(0);
    expect(fakes.agents).toHaveLength(0);
    const peer = admit(f);
    expect(peer.setRemoteAiAllowed).toHaveBeenCalledWith(true);
    expect(fakes.agents).toHaveLength(0);
    peer.state = "connected";
    peer.changed();
    expect(fakes.agents).toHaveLength(0);
    connect(peer, false);
    expect(fakes.agents).toHaveLength(0);
    connect(peer, true);
    peer.changed();
    peer.changed();
    await flush();
    expect(fakes.agents).toHaveLength(1);
    expect(fakes.agents[0].start).toHaveBeenCalledOnce();
    expect(fakes.agents[0].identity).toMatchObject({
      name: "Yori",
      peerName: "GPT",
      startsConversation: true,
    });
    expect(f.active).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.call.ready).toBe(false);
    peer.message?.(frame(1, { type: "ready", ready: true }));
    expect(f.call.ready).toBe(true);
    peer.revoke?.();
    expect(f.call.closed).toBe(true);
    expect(fakes.agents[0].setInputEnabled).toHaveBeenCalledWith(false);
    expect(fakes.agents[0].stop).toHaveBeenCalledOnce();
  });

  it("does not create another agent while asynchronous start is pending and closes pending work on leave", async () => {
    let finish: () => void = () => {};
    fakes.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture();
    const peer = admit(f);
    connect(peer);
    peer.changed();
    peer.changed();
    await flush();
    expect(fakes.agents).toHaveLength(1);
    f.call.leave();
    finish();
    await flush();
    expect(f.call.closed).toBe(true);
    expect(
      peer.sendMessage.mock.calls.some(([value]) => value.type === "ready" && value.ready),
    ).toBe(false);
    expect(f.signal.close).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(fakes.transfers[0].close).toHaveBeenCalledOnce();
    f.call.leave();
    expect(f.signal.close).toHaveBeenCalledOnce();
  });

  it("pauses both agents, confirms shutdown, resumes with fresh generations, and ignores late callbacks", async () => {
    const f = await pair();
    f.host.call.pause();
    expect(f.host.call.paused).toBe(true);
    expect(f.guest.call.paused).toBe(true);
    expect(f.hostAgent.setInputEnabled).toHaveBeenCalledWith(false);
    expect(f.guestAgent.setInputEnabled).toHaveBeenCalledWith(false);
    expect(f.hostAgent.stop).toHaveBeenCalledOnce();
    expect(f.guestAgent.stop).toHaveBeenCalledOnce();
    expect(f.hostPeer.setOutput).toHaveBeenCalledWith(false);
    expect(f.guestPeer.setOutput).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(6000);
    expect(f.host.call.closed).toBe(false);
    expect(f.guest.call.closed).toBe(false);
    await f.host.call.resume();
    await flush();
    expect(fakes.agents).toHaveLength(4);
    expect(f.host.call.ready).toBe(true);
    expect(f.guest.call.ready).toBe(true);
    f.hostAgent.callbacks.transcript({
      id: "old",
      agentId: "old",
      label: "Yori",
      role: "assistant",
      text: "late audio",
    });
    f.hostAgent.callbacks.activity?.("responding");
    f.hostAgent.callbacks.ended("old provider error");
    expect(f.host.call.transcripts).toHaveLength(0);
    expect(f.host.call.paused).toBe(false);
    expect(f.host.call.error).toBe("");
  });

  it.each([
    "host",
    "guest",
  ] as const)("clears the %s's previous voice error when the other endpoint resumes", async (failedSide) => {
    const f = await pair();
    const failed = failedSide === "host" ? f.host : f.guest;
    const recovering = failedSide === "host" ? f.guest : f.host;
    const failedAgent = failedSide === "host" ? f.hostAgent : f.guestAgent;
    failedAgent.callbacks.ended("The call AI process stopped.");
    expect(failed.call.error).toBe("The call AI process stopped.");
    expect(f.host.call.paused).toBe(true);
    expect(f.guest.call.paused).toBe(true);
    const resumed = recovering.call.resume();
    // The accepted retry replaces the old error before the new agent is ready.
    expect(failed.call.paused).toBe(false);
    expect(failed.call.error).toBe("");
    await resumed;
    await flush();
    expect(f.host.call.ready).toBe(true);
    expect(f.guest.call.ready).toBe(true);
    expect(f.host.call.error).toBe("");
    expect(f.guest.call.error).toBe("");
  });

  it("fails closed if a pause cannot be delivered or acknowledged", async () => {
    const missingAck = fixture();
    const first = admit(missingAck);
    connect(first);
    await flush();
    missingAck.call.pause();
    vi.advanceTimersByTime(5000);
    expect(missingAck.call.closed).toBe(true);
    const failedSend = fixture();
    const second = admit(failedSend);
    connect(second);
    await flush();
    second.sendMessage.mockReturnValue(false);
    failedSend.call.pause();
    expect(failedSend.call.closed).toBe(true);
  });

  it("pauses on provider startup failure and never auto-restarts until explicit resume", async () => {
    fakes.start.mockRejectedValueOnce(new Error("provider unavailable"));
    const f = fixture();
    const peer = admit(f);
    connect(peer);
    await flush();
    expect(f.call.paused).toBe(true);
    expect(f.call.error).toContain("provider unavailable");
    peer.changed();
    await flush();
    expect(fakes.agents).toHaveLength(1);
  });

  it("pauses safely when the native audio constructor throws", async () => {
    fakes.throwConstructor = true;
    const f = fixture();
    const peer = admit(f);
    connect(peer);
    await flush();
    expect(f.call.paused).toBe(true);
    expect(f.call.error).toContain("audio constructor failed");
    expect(fakes.agents).toHaveLength(0);
  });

  it("fails closed when local output cannot be muted for a pause", async () => {
    const f = fixture();
    const peer = admit(f);
    connect(peer);
    await flush();
    peer.setOutput.mockRejectedValueOnce(new Error("mute failed"));
    f.call.pause();
    await flush();
    expect(f.call.closed).toBe(true);
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("ignores an old voice lookup rejection after a newer generation has resumed", async () => {
    let rejectVoice: (error: Error) => void = () => {};
    const getVoice = vi
      .fn<() => Promise<string | undefined>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectVoice = reject;
          }),
      )
      .mockResolvedValue("sage");
    const f = fixture("host", undefined, { getVoice });
    const peer = admit(f);
    connect(peer);
    expect(fakes.agents).toHaveLength(0);
    f.call.pause();
    await f.call.resume();
    await flush();
    expect(fakes.agents).toHaveLength(1);
    expect(f.call.paused).toBe(false);
    rejectVoice(new Error("obsolete voice lookup failure"));
    await flush();
    expect(f.call.paused).toBe(false);
    expect(f.call.error).toBe("");
    expect(fakes.agents[0].stop).not.toHaveBeenCalled();
  });
});

describe("real participant input routing", () => {
  it("delivers a named topic to one agent and never fabricates either AI's transcript", async () => {
    const f = await pair();
    await f.host.call.submitTopic("GPT、安心できる会話についてどう思う？");
    await flush();
    expect(f.hostAgent.requestTurn).not.toHaveBeenCalled();
    expect(f.guestAgent.requestTurn).toHaveBeenCalledOnce();
    expect(f.guestAgent.requestTurn.mock.calls[0][0]).toContain("Respond as GPT");
    expect(f.guestAgent.requestTurn.mock.calls[0][0]).toContain("Do not perform both sides");
    expect(f.host.call.transcripts.map((item) => item.speaker)).toEqual(["あなた"]);
    expect(f.guest.call.transcripts.map((item) => item.speaker)).toEqual(["相手のユーザー"]);
    f.guestAgent.callbacks.transcript({
      id: "actual",
      agentId: "guest-ai",
      label: "GPT",
      role: "assistant",
      text: "Actual provider transcript",
    });
    expect(f.host.call.transcripts[1]).toMatchObject({
      speaker: "GPT",
      text: "Actual provider transcript",
    });
    expect(f.guest.call.transcripts[1]).toMatchObject({
      speaker: "GPT",
      text: "Actual provider transcript",
    });
    expect(f.hostAgent.requestTurn).not.toHaveBeenCalled();
  });

  it("seeds an unaddressed topic only at the host and treats typed/ASR stop as room pause", async () => {
    const f = await pair();
    await f.guest.call.submitTopic("好きな季節について話して");
    await flush();
    expect(f.hostAgent.requestTurn).toHaveBeenCalledOnce();
    expect(f.guestAgent.requestTurn).not.toHaveBeenCalled();
    f.guestAgent.callbacks.transcript({
      id: "human",
      agentId: "guest-ai",
      label: "GPT",
      role: "user",
      text: "二人とも、止めて",
    });
    expect(f.host.call.paused).toBe(true);
    expect(f.guest.call.paused).toBe(true);
    await expect(f.host.call.submitTopic("新しいお題")).rejects.toThrow();
  });

  it("drops spoofed, replayed, stale-epoch, and oversized control input", async () => {
    const f = fixture();
    const peer = admit(f);
    connect(peer);
    await flush();
    peer.message?.(frame(10, { type: "transcript", text: "spoof", sender: "host" }));
    peer.message?.(frame(9, { type: "transcript", text: "wrong room", roomId: "other" }));
    peer.message?.(frame(8, { type: "transcript", text: "x".repeat(2001) }));
    peer.message?.(frame(1, { type: "transcript", text: "valid" }));
    peer.message?.(frame(1, { type: "transcript", text: "replay" }));
    expect(f.call.transcripts.map((item) => item.text)).toEqual(["valid"]);
    f.call.pause();
    peer.message?.(frame(2, { type: "transcript", text: "old epoch" }));
    peer.message?.(
      frame(3, { type: "state", epoch: { counter: 0, owner: "guest", paused: false } }),
    );
    expect(f.call.paused).toBe(true);
    expect(f.call.transcripts).toHaveLength(1);
  });
});

describe("actual avatar byte ownership", () => {
  it("shares local avatar once after channel readiness and renders only received bytes", async () => {
    const f = fixture("host", "asset://actual-local.vrm");
    const peer = admit(f);
    const transfer = fakes.transfers[0];
    peer.assetReady?.();
    expect(fakes.bytes).not.toHaveBeenCalled();
    connect(peer);
    await flush();
    expect(fakes.bytes).toHaveBeenCalledExactlyOnceWith("asset://actual-local.vrm");
    expect(transfer.send).toHaveBeenCalledOnce();
    peer.assetReady?.();
    peer.changed();
    await flush();
    expect(transfer.send).toHaveBeenCalledOnce();
    expect(f.call.remoteAvatarUrl).toBeNull();
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    peer.asset?.(bytes);
    expect(transfer.accept).toHaveBeenCalledWith(bytes);
    transfer.received?.(bytes);
    expect(f.call.remoteAvatarUrl).toBe("blob:remote-avatar");
    expect(isIssuedCallAvatarUrl("blob:remote-avatar")).toBe(true);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("model/gltf-binary");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(bytes));
    transfer.received?.(bytes);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:remote-avatar");
    f.call.leave();
    expect(f.call.remoteAvatarUrl).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(isIssuedCallAvatarUrl("blob:remote-avatar")).toBe(false);
  });

  it("does not transmit cached avatar bytes that resolve after room closure", async () => {
    let resolveBytes: (bytes: ArrayBuffer) => void = () => {};
    fakes.bytes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBytes = resolve;
        }),
    );
    const f = fixture("host", "asset://local.vrm");
    const peer = admit(f);
    connect(peer);
    peer.assetReady?.();
    f.call.leave();
    resolveBytes(new ArrayBuffer(8));
    await flush();
    expect(fakes.transfers[0].send).not.toHaveBeenCalled();
  });
});

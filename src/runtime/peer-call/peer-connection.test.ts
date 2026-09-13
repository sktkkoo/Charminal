import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerCallConnection, type PeerCallConnectionOptions } from "./peer-connection";

const SDP =
  "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
function splitSdp(mids = ["human-mid", "agent-mid"]): string {
  return `v=0\r\n${mids.map((mid) => `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:${mid}\r\n`).join("")}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\n`;
}
function productSignal(type: "offer" | "answer", fields: Record<string, unknown> = {}): string {
  return signal(type, {
    version: 2,
    sdp: splitSdp(),
    audio: { human: "human-mid", agent: "agent-mid" },
    ...fields,
  });
}
function sdpAudioMids(sdp: string): (string | null)[] {
  return sdp
    .split(/\r?\n(?=m=)/)
    .slice(1)
    .filter((section) => section.startsWith("m=audio "))
    .map(
      (section) =>
        section
          .split(/\r?\n/)
          .find((line) => line.startsWith("a=mid:"))
          ?.slice(6) ?? null,
    );
}
const ROOM = "12345678-1234-1234-1234-123456789012";
const CODECS = [
  { mimeType: "audio/PCMU", clockRate: 8000 },
  { mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { mimeType: "audio/red", clockRate: 48000, channels: 2 },
];

function signal(type: "offer" | "answer", fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, roomId: ROOM, type, sdp: SDP, ...fields });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

class FakeTrack {
  readyState: MediaStreamTrackState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });

  constructor(readonly kind = "audio") {}

  asTrack(): MediaStreamTrack {
    return this as unknown as MediaStreamTrack;
  }
}

class FakeTransceiver {
  mid: string | null = null;
  direction: RTCRtpTransceiverDirection = "recvonly";
  receiver = { track: new FakeTrack().asTrack() };
  sender = {
    track: null as MediaStreamTrack | null,
    replaceTrack: vi.fn(async (track: MediaStreamTrack | null) => {
      this.sender.track = track;
    }),
    setParameters: vi.fn(),
  };
  setCodecPreferences = vi.fn();
}

class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  maxPacketLifeTime: number | null = null;
  maxRetransmits: number | null = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });

  constructor(
    readonly label = "yorishiro-motion-v1",
    readonly ordered = false,
  ) {}
}

class FakePC extends EventTarget {
  static instances: FakePC[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: MediaStreamTrack; transceiver?: FakeTransceiver }) => void) | null =
    null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  transceivers: FakeTransceiver[] = [];
  channels: FakeChannel[] = [];
  addTransceiver = vi.fn((_kind: string, init: RTCRtpTransceiverInit) => {
    const transceiver = new FakeTransceiver();
    transceiver.direction = init.direction ?? "sendrecv";
    this.transceivers.push(transceiver);
    return transceiver;
  });
  getTransceivers = vi.fn(() => this.transceivers);
  createDataChannel = vi.fn((label: string, options: RTCDataChannelInit) => {
    const channel = new FakeChannel(label, options.ordered);
    channel.maxRetransmits = options.maxRetransmits ?? null;
    this.channels.push(channel);
    return channel;
  });
  createOffer = vi.fn(
    async (): Promise<RTCSessionDescriptionInit> => ({
      type: "offer",
      sdp: this.transceivers.length === 2 ? splitSdp() : SDP,
    }),
  );
  createAnswer = vi.fn(
    async (): Promise<RTCSessionDescriptionInit> => ({
      type: "answer",
      sdp:
        this.transceivers.length === 2
          ? splitSdp(this.transceivers.map((item) => item.mid ?? "missing"))
          : SDP,
    }),
  );
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
    sdpAudioMids(description.sdp ?? "").forEach((mid, index) => {
      if (this.transceivers[index]) this.transceivers[index].mid = mid;
    });
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (description.type === "offer") {
      for (const mid of sdpAudioMids(description.sdp ?? "")) {
        const transceiver = new FakeTransceiver();
        transceiver.mid = mid;
        this.transceivers.push(transceiver);
      }
    }
  });
  getStats = vi.fn(async () => new Map() as RTCStatsReport);
  close = vi.fn(() => {
    this.connectionState = "closed";
  });

  constructor(readonly config: RTCConfiguration) {
    super();
    FakePC.instances.push(this);
  }
}

let connections: PeerCallConnection[];

function connection(options: PeerCallConnectionOptions = {}) {
  const result = new PeerCallConnection(options);
  connections.push(result);
  const pc = FakePC.instances[FakePC.instances.length - 1];
  if (!pc) throw new Error("Fake peer connection missing");
  return { connection: result, pc };
}

function audio(pc: FakePC): FakeTransceiver {
  const transceiver = pc.transceivers[0];
  if (!transceiver) throw new Error("Audio transceiver missing");
  return transceiver;
}

function motion(pc: FakePC): FakeChannel {
  const channel = pc.channels[0];
  if (!channel) throw new Error("Motion channel missing");
  return channel;
}

beforeEach(() => {
  connections = [];
  FakePC.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: vi.fn(() => ({ codecs: CODECS })) });
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(readonly tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );
});

afterEach(() => {
  for (const item of connections) item.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PeerCallConnection negotiation", () => {
  it("reserves sendrecv audio before offering and prefers Opus without discarding codecs or capping bitrate", async () => {
    const { connection: call, pc } = connection();
    expect(pc.config.iceServers).toEqual([]);
    await call.createOffer();
    expect(pc.addTransceiver).toHaveBeenCalledExactlyOnceWith("audio", { direction: "sendrecv" });
    expect(pc.addTransceiver.mock.invocationCallOrder[0]).toBeLessThan(
      pc.createOffer.mock.invocationCallOrder[0],
    );
    expect(audio(pc).setCodecPreferences).toHaveBeenCalledExactlyOnceWith([
      CODECS[1],
      CODECS[0],
      CODECS[2],
    ]);
    expect(audio(pc).sender.setParameters).not.toHaveBeenCalled();
    expect(audio(pc).sender.track).toBeNull();
    expect(pc.createDataChannel).toHaveBeenCalledExactlyOnceWith("yorishiro-motion-v1", {
      ordered: false,
      maxRetransmits: 0,
    });
  });

  it("uses only explicitly configured ICE servers and keeps native codecs if the preference API is absent", async () => {
    vi.stubGlobal("RTCRtpReceiver", undefined);
    const iceServers = [{ urls: "stun:example.invalid" }];
    const { connection: call, pc } = connection({ iceServers });
    await call.createOffer();
    expect(pc.config.iceServers).toEqual(iceServers);
    expect(audio(pc).setCodecPreferences).not.toHaveBeenCalled();
  });

  it("answers with the remote offer's associated audio transceiver", async () => {
    const { connection: call, pc } = connection();
    const source = new FakeTrack();
    await call.setAudioTrack(source.asTrack());
    expect(pc.transceivers).toHaveLength(0);
    const answer: unknown = JSON.parse(await call.acceptOffer(signal("offer")));
    expect(answer).toEqual({ version: 1, roomId: ROOM, type: "answer", sdp: SDP });
    expect(pc.addTransceiver).not.toHaveBeenCalled();
    expect(pc.transceivers).toHaveLength(1);
    expect(audio(pc).direction).toBe("sendrecv");
    expect(audio(pc).sender.track).toBe(source);
    await expect(call.acceptOffer(signal("offer"))).rejects.toThrow("duplicate");
  });

  it("waits for complete ICE and serializes the final description, not the early offer", async () => {
    const { connection: call, pc } = connection();
    pc.iceGatheringState = "gathering";
    const completed = vi.fn();
    const offer = call.createOffer().then((value) => {
      completed();
      return value;
    });
    await flush();
    expect(completed).not.toHaveBeenCalled();
    const finalSdp = `${SDP}a=candidate:final\r\n`;
    pc.localDescription = { type: "offer", sdp: finalSdp };
    pc.iceGatheringState = "complete";
    pc.dispatchEvent(new Event("icegatheringstatechange"));
    expect(JSON.parse(await offer).sdp).toBe(finalSdp);
  });

  it("rejects stale answers across instances, then accepts one matching answer only", async () => {
    const first = connection();
    const second = connection();
    const firstOffer = JSON.parse(await first.connection.createOffer());
    const secondOffer = JSON.parse(await second.connection.createOffer());
    expect(firstOffer.roomId).not.toBe(secondOffer.roomId);
    await expect(
      second.connection.acceptAnswer(signal("answer", { roomId: firstOffer.roomId })),
    ).rejects.toThrow("different invitation");
    expect(second.pc.setRemoteDescription).not.toHaveBeenCalled();
    await second.connection.acceptAnswer(signal("answer", { roomId: secondOffer.roomId }));
    await expect(
      second.connection.acceptAnswer(signal("answer", { roomId: secondOffer.roomId })),
    ).rejects.toThrow("duplicate");
    await expect(second.connection.createOffer()).rejects.toThrow("duplicate");
    expect(second.pc.setRemoteDescription).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent negotiation attempts before invoking another native operation", async () => {
    const { connection: call, pc } = connection();
    const pending = deferred<RTCSessionDescriptionInit>();
    pc.createOffer.mockReturnValueOnce(pending.promise);
    const offer = call.createOffer();
    await expect(call.createOffer()).rejects.toThrow("duplicate");
    await expect(call.acceptOffer(signal("offer"))).rejects.toThrow("duplicate");
    pending.resolve({ type: "offer", sdp: SDP });
    await offer;
    expect(pc.createOffer).toHaveBeenCalledTimes(1);
  });

  it("validates bounded, versioned audio-only envelopes before touching native remote state", async () => {
    const { connection: call, pc } = connection();
    const invalid = [
      "not json",
      "null",
      "[]",
      "x".repeat(128 * 1024 + 1),
      signal("answer"),
      signal("offer", { version: 2 }),
      signal("offer", { roomId: "someone else's room" }),
      signal("offer", { extra: "field" }),
      signal("offer", { sdp: "" }),
      signal("offer", { sdp: `${SDP}\0` }),
      signal("offer", { sdp: `${SDP}${"a".repeat(64 * 1024)}` }),
      signal("offer", { sdp: `${SDP}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n` }),
      signal("offer", { sdp: SDP.replace("m=audio ", "m=video ") }),
    ];
    for (const item of invalid) await expect(call.acceptOffer(item)).rejects.toThrow();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    await call.acceptOffer(signal("offer"));
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
  });

  it("closes on a native negotiation failure and prevents retry on partially configured state", async () => {
    const onError = vi.fn();
    const { connection: call, pc } = connection({ onError });
    pc.setRemoteDescription.mockRejectedValueOnce(new Error("bad SDP"));
    await expect(call.acceptOffer(signal("offer"))).rejects.toThrow("bad SDP");
    expect(pc.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    await expect(call.createOffer()).rejects.toThrow("closed");
  });

  it("cancels ICE gathering on timeout, releasing the chosen source", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { connection: call, pc } = connection({ onError });
    const source = new FakeTrack();
    await call.setAudioTrack(source.asTrack());
    pc.iceGatheringState = "gathering";
    const failed = expect(call.createOffer()).rejects.toThrow("ICE gathering timed out");
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(source.stop).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending native offer immediately and ignores its late result", async () => {
    const { connection: call, pc } = connection();
    const pending = deferred<RTCSessionDescriptionInit>();
    pc.createOffer.mockReturnValueOnce(pending.promise);
    const failed = expect(call.createOffer()).rejects.toThrow("closed");
    call.close();
    await failed;
    pending.resolve({ type: "offer", sdp: SDP });
    await flush();
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
  });

  it("cancels pending remote-description and stats results without applying later work", async () => {
    const { connection: call, pc } = connection();
    const remote = deferred<void>();
    const stats = deferred<RTCStatsReport>();
    pc.setRemoteDescription.mockReturnValueOnce(remote.promise);
    pc.getStats.mockReturnValueOnce(stats.promise);
    const answerFailed = expect(call.acceptOffer(signal("offer"))).rejects.toThrow("closed");
    const statsFailed = expect(call.getStats()).rejects.toThrow("closed");
    call.close();
    await Promise.all([answerFailed, statsFailed]);
    remote.resolve();
    stats.resolve(new Map() as RTCStatsReport);
    await flush();
    expect(pc.createAnswer).not.toHaveBeenCalled();
    await expect(call.acceptAnswer(signal("answer"))).rejects.toThrow("closed");
    await expect(call.getStats()).rejects.toThrow("closed");
  });
});

describe("PeerCallConnection audio ownership", () => {
  it("only attaches explicitly selected audio and stops replaced tracks", async () => {
    const { connection: call, pc } = connection();
    await call.createOffer();
    const first = new FakeTrack();
    const second = new FakeTrack();
    await call.setAudioTrack(first.asTrack());
    await call.setAudioTrack(second.asTrack());
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect(audio(pc).sender.track).toBe(second);
    call.close();
    call.close();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(audio(pc).sender.replaceTrack).toHaveBeenLastCalledWith(null);
  });

  it("leaves invalid or post-close caller-owned tracks untouched", async () => {
    const { connection: call } = connection();
    const video = new FakeTrack("video");
    await expect(call.setAudioTrack(video.asTrack())).rejects.toThrow("live audio");
    expect(video.stop).not.toHaveBeenCalled();
    call.close();
    const late = new FakeTrack();
    await expect(call.setAudioTrack(late.asTrack())).rejects.toThrow("closed");
    expect(late.stop).not.toHaveBeenCalled();
  });

  it("keeps the previous source if native replacement fails and releases the failed source", async () => {
    const { connection: call, pc } = connection();
    await call.createOffer();
    const current = new FakeTrack();
    const rejected = new FakeTrack();
    await call.setAudioTrack(current.asTrack());
    audio(pc).sender.replaceTrack.mockRejectedValueOnce(new Error("codec mismatch"));
    await expect(call.setAudioTrack(rejected.asTrack())).rejects.toThrow("codec mismatch");
    expect(audio(pc).sender.track).toBe(current);
    expect(current.stop).not.toHaveBeenCalled();
    expect(rejected.stop).toHaveBeenCalledOnce();
  });

  it("skips superseded queued sources without attaching them", async () => {
    const { connection: call, pc } = connection();
    await call.createOffer();
    const stale = new FakeTrack();
    const latest = new FakeTrack();
    const staleFailed = expect(call.setAudioTrack(stale.asTrack())).rejects.toThrow("superseded");
    await call.setAudioTrack(latest.asTrack());
    await staleFailed;
    expect(stale.stop).toHaveBeenCalledOnce();
    expect(audio(pc).sender.replaceTrack).not.toHaveBeenCalledWith(stale);
    expect(audio(pc).sender.track).toBe(latest);
  });

  it("revokes capture immediately while replacement is pending, and cannot resurrect that source", async () => {
    const { connection: call, pc } = connection();
    await call.createOffer();
    const source = new FakeTrack();
    const pending = deferred<void>();
    audio(pc).sender.replaceTrack.mockReturnValueOnce(pending.promise);
    const staleFailed = expect(call.setAudioTrack(source.asTrack())).rejects.toThrow("superseded");
    await flush();
    const mute = call.setAudioTrack(null);
    expect(source.stop).toHaveBeenCalledOnce();
    pending.resolve();
    await Promise.all([staleFailed, mute]);
    expect(source.readyState).toBe("ended");
    expect(audio(pc).sender.replaceTrack).toHaveBeenLastCalledWith(null);
  });

  it("does not stop a source reused by a newer overlapping selection", async () => {
    const { connection: call, pc } = connection();
    await call.createOffer();
    const source = new FakeTrack();
    const pending = deferred<void>();
    audio(pc).sender.replaceTrack.mockReturnValueOnce(pending.promise);
    const staleFailed = expect(call.setAudioTrack(source.asTrack())).rejects.toThrow("superseded");
    await flush();
    const latest = call.setAudioTrack(source.asTrack());
    pending.resolve();
    await Promise.all([staleFailed, latest]);
    expect(source.stop).not.toHaveBeenCalled();
    expect(audio(pc).sender.track).toBe(source);
  });

  it("stops active and queued sources and cancels pending updates when closing", async () => {
    const { connection: call, pc } = connection();
    await call.createOffer();
    const first = new FakeTrack();
    const second = new FakeTrack();
    const pending = deferred<void>();
    audio(pc).sender.replaceTrack.mockReturnValueOnce(pending.promise);
    const firstFailed = expect(call.setAudioTrack(first.asTrack())).rejects.toThrow("closed");
    await flush();
    const secondFailed = expect(call.setAudioTrack(second.asTrack())).rejects.toThrow("closed");
    call.close();
    await Promise.all([firstFailed, secondFailed]);
    pending.resolve();
    await flush();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(audio(pc).sender.replaceTrack).not.toHaveBeenCalledWith(second);
  });
});

describe("PeerCallConnection motion and events", () => {
  it("drops unsendable or oversized motion and applies byte backpressure", async () => {
    const { connection: call, pc } = connection();
    expect(call.sendMotion(new ArrayBuffer(8))).toBe(false);
    await call.createOffer();
    const channel = motion(pc);
    expect(call.sendMotion(new ArrayBuffer(8))).toBe(false);
    channel.readyState = "open";
    expect(call.sendMotion(new ArrayBuffer(0))).toBe(false);
    expect(call.sendMotion(new ArrayBuffer(16 * 1024 + 1))).toBe(false);
    expect(call.sendMotion(new ArrayBuffer(16 * 1024))).toBe(true);
    channel.bufferedAmount = 64 * 1024 - 8;
    expect(call.sendMotion(new ArrayBuffer(8))).toBe(true);
    expect(call.sendMotion(new ArrayBuffer(9))).toBe(false);
    call.close();
    expect(call.sendMotion(new ArrayBuffer(8))).toBe(false);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("accepts only the bounded unreliable binary motion channel and ignores late messages", async () => {
    const onMotion = vi.fn();
    const { connection: call, pc } = connection({ onMotion });
    await call.acceptOffer(signal("offer"));
    for (const rejected of [
      new FakeChannel("control"),
      new FakeChannel("yorishiro-motion-v1", true),
    ]) {
      pc.ondatachannel?.({ channel: rejected });
      expect(rejected.close).toHaveBeenCalledOnce();
    }
    const channel = new FakeChannel();
    pc.ondatachannel?.({ channel });
    expect(channel.binaryType).toBe("arraybuffer");
    const message = channel.onmessage;
    message?.({ data: "text" });
    message?.({ data: new ArrayBuffer(16 * 1024 + 1) });
    const payload = new ArrayBuffer(8);
    message?.({ data: payload });
    expect(onMotion).toHaveBeenCalledExactlyOnceWith(payload);
    const duplicate = new FakeChannel();
    pc.ondatachannel?.({ channel: duplicate });
    expect(duplicate.close).toHaveBeenCalledOnce();
    call.close();
    message?.({ data: payload });
    expect(onMotion).toHaveBeenCalledOnce();
  });

  it("delivers streamless audio tracks, closes on failure, and suppresses late callbacks", async () => {
    const onRemoteStream = vi.fn();
    const onState = vi.fn();
    const onError = vi.fn();
    const { connection: call, pc } = connection({ onRemoteStream, onState, onError });
    await call.createOffer();
    const local = new FakeTrack();
    await call.setAudioTrack(local.asTrack());
    const remote = new FakeTrack();
    const onTrack = pc.ontrack;
    const onConnectionState = pc.onconnectionstatechange;
    onTrack?.({ track: remote.asTrack() });
    expect(onRemoteStream.mock.calls[0][0].getTracks()).toEqual([remote]);
    expect(onRemoteStream.mock.calls[0][1]).toBe("unknown");
    pc.connectionState = "failed";
    onConnectionState?.();
    expect(onState.mock.calls.map(([state]) => state)).toEqual(["failed", "closed"]);
    expect(onError).toHaveBeenCalledOnce();
    expect(local.stop).toHaveBeenCalledOnce();
    expect(remote.stop).toHaveBeenCalledOnce();
    const late = new FakeTrack();
    onTrack?.({ track: late.asTrack() });
    onConnectionState?.();
    expect(late.stop).toHaveBeenCalledOnce();
    expect(onRemoteStream).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledTimes(2);
  });
});

describe("native call consent transport", () => {
  it("keeps consent reliable and separate from lossy avatar motion", async () => {
    const onControl = vi.fn();
    const onControlOpen = vi.fn();
    const { connection: call, pc } = connection({ productCall: true, onControl, onControlOpen });
    await call.createOffer();
    const control = pc.channels[1] as FakeChannel & { onopen?: () => void; onclose?: () => void };
    expect(control.label).toBe("yorishiro-call-control-v1");
    expect(control.ordered).toBe(true);
    expect(control.maxRetransmits).toBeNull();
    expect(call.sendControl("{}")).toBe(false);
    control.readyState = "open";
    control.onopen?.();
    expect(onControlOpen).toHaveBeenCalledOnce();
    expect(call.sendControl("{}")).toBe(true);
    control.onmessage?.({ data: "consent" });
    expect(onControl).toHaveBeenCalledWith("consent");
    control.onmessage?.({ data: "あ".repeat(5500) });
    expect(onControl).toHaveBeenCalledOnce();
    control.bufferedAmount = 65536;
    expect(call.sendControl("{}")).toBe(false);
    call.close();
    expect(control.close).toHaveBeenCalledOnce();
  });
});

describe("separate product audio sources", () => {
  it("negotiates both senders initially and replaces or mutes either source independently", async () => {
    const { connection: call, pc } = connection({ productCall: true });
    const human = new FakeTrack();
    const agent = new FakeTrack();
    await Promise.all([
      call.setAudioTrack(human.asTrack(), "human"),
      call.setAudioTrack(agent.asTrack(), "agent"),
    ]);
    const offer = JSON.parse(await call.createOffer());
    expect(offer).toMatchObject({ version: 2, audio: { human: "human-mid", agent: "agent-mid" } });
    expect(pc.transceivers.map((item) => item.sender.track)).toEqual([human, agent]);
    expect(pc.addTransceiver).toHaveBeenCalledTimes(2);
    for (const transceiver of pc.transceivers) {
      expect(transceiver.direction).toBe("sendrecv");
      expect(transceiver.sender.replaceTrack.mock.invocationCallOrder[0]).toBeLessThan(
        pc.createOffer.mock.invocationCallOrder[0],
      );
    }
    const replacement = new FakeTrack();
    await call.setAudioTrack(replacement.asTrack(), "agent");
    expect(agent.stop).toHaveBeenCalledOnce();
    await call.setAudioTrack(null, "human");
    expect(human.stop).toHaveBeenCalledOnce();
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(pc.transceivers.map((item) => item.sender.track)).toEqual([null, replacement]);
    expect(pc.createOffer).toHaveBeenCalledOnce();
    expect(pc.addTransceiver).toHaveBeenCalledTimes(2);
    call.close();
    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(pc.transceivers.every((item) => item.sender.track === null)).toBe(true);
  });

  it("routes track events during remote-description application by MID even when audio order is reversed", async () => {
    const onRemoteStream = vi.fn();
    const { connection: call, pc } = connection({ productCall: true, onRemoteStream });
    const human = new FakeTrack();
    const agent = new FakeTrack();
    await call.setAudioTrack(human.asTrack(), "human");
    await call.setAudioTrack(agent.asTrack(), "agent");
    const applied = deferred<void>();
    pc.setRemoteDescription.mockImplementationOnce(() => {
      for (const mid of ["agent-mid", "human-mid"]) {
        const transceiver = new FakeTransceiver();
        transceiver.mid = mid;
        pc.transceivers.push(transceiver);
      }
      // Arrival order differs from both m-section order and role ordering.
      for (const transceiver of [...pc.transceivers].reverse()) {
        pc.ontrack?.({ track: transceiver.receiver.track, transceiver });
      }
      return applied.promise;
    });
    const pending = call.acceptOffer(
      productSignal("offer", { sdp: splitSdp(["agent-mid", "human-mid"]) }),
    );
    expect(onRemoteStream.mock.calls.map(([, kind]) => kind)).toEqual(["human", "agent"]);
    expect(onRemoteStream.mock.calls[0][0].getTracks()).toEqual([
      pc.transceivers[1].receiver.track,
    ]);
    applied.resolve();
    const answer = JSON.parse(await pending);
    expect(answer.audio).toEqual({ human: "human-mid", agent: "agent-mid" });
    expect(pc.transceivers.map((item) => item.sender.track)).toEqual([agent, human]);
    expect(pc.addTransceiver).not.toHaveBeenCalled();
    call.close();
    expect(pc.transceivers.every((item) => item.receiver.track.readyState === "ended")).toBe(true);
  });

  it("maps answer-side track callbacks before the remote answer promise resolves", async () => {
    const onRemoteStream = vi.fn();
    const { connection: call, pc } = connection({ productCall: true, onRemoteStream });
    const offer = JSON.parse(await call.createOffer());
    pc.setRemoteDescription.mockImplementationOnce(async () => {
      for (const transceiver of [...pc.transceivers].reverse())
        pc.ontrack?.({ track: transceiver.receiver.track, transceiver });
    });
    await call.acceptAnswer(productSignal("answer", { roomId: offer.roomId }));
    expect(onRemoteStream.mock.calls.map(([, kind]) => kind)).toEqual(["agent", "human"]);
  });

  it("rejects legacy product audio and malformed or ambiguous MID mappings before native negotiation", async () => {
    const { connection: call, pc } = connection({ productCall: true });
    await expect(call.acceptOffer(signal("offer"))).rejects.toThrow("音声分離に対応した同じ版");
    for (const fields of [
      { audio: null },
      { audio: { human: "human-mid" } },
      { audio: { human: "human-mid", agent: "agent-mid", tool: "execute" } },
      { audio: { human: "human-mid", agent: "human-mid" } },
      { audio: { human: "human-mid", agent: "data" } },
      { audio: { human: "human-mid", agent: "absent" } },
      { audio: { human: "human-mid", agent: "a".repeat(65) } },
      { sdp: splitSdp().replace("a=mid:agent-mid", "a=mid:human-mid") },
      { sdp: splitSdp().replace("a=mid:agent-mid", "a=mid:agent-mid\r\na=mid:other") },
      { sdp: splitSdp().replace("a=mid:agent-mid\r\n", "") },
      { sdp: splitSdp().replace("m=audio ", "m=video ") },
    ])
      await expect(call.acceptOffer(productSignal("offer", fields))).rejects.toThrow();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("rejects an answer that swaps the offered human and AI roles", async () => {
    const { connection: call, pc } = connection({ productCall: true });
    const offer = JSON.parse(await call.createOffer());
    await expect(
      call.acceptAnswer(
        productSignal("answer", {
          roomId: offer.roomId,
          audio: { human: "agent-mid", agent: "human-mid" },
        }),
      ),
    ).rejects.toThrow("changed the negotiated audio sources");
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("never forwards an unknown product MID as either AI or human audio", async () => {
    const onRemoteStream = vi.fn();
    const { connection: call, pc } = connection({ productCall: true, onRemoteStream });
    await call.acceptOffer(productSignal("offer"));
    const transceiver = new FakeTransceiver();
    transceiver.mid = "unidentified";
    pc.ontrack?.({ track: transceiver.receiver.track, transceiver });
    expect(transceiver.receiver.track.readyState).toBe("ended");
    expect(onRemoteStream).not.toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("does not let muting a queued microphone update cancel AI output", async () => {
    const { connection: call, pc } = connection({ productCall: true });
    await call.createOffer();
    const pending = deferred<void>();
    pc.transceivers[0].sender.replaceTrack.mockReturnValueOnce(pending.promise);
    const human = new FakeTrack();
    const agent = new FakeTrack();
    const superseded = expect(call.setAudioTrack(human.asTrack(), "human")).rejects.toThrow(
      "superseded",
    );
    await flush();
    await call.setAudioTrack(agent.asTrack(), "agent");
    const mute = call.setAudioTrack(null, "human");
    expect(human.stop).toHaveBeenCalledOnce();
    expect(agent.stop).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([mute, superseded]);
    expect(pc.transceivers[1].sender.track).toBe(agent);
    await expect(call.setAudioTrack(agent.asTrack(), "human")).rejects.toThrow("dedicated track");
    expect(agent.stop).not.toHaveBeenCalled();
  });
});

describe("native avatar transfer transport", () => {
  it("separates bounded reliable asset packets from audio, motion and room control", async () => {
    const onAsset = vi.fn();
    const onAssetOpen = vi.fn();
    const { connection: call, pc } = connection({ productCall: true, onAsset, onAssetOpen });
    await call.createOffer();
    const asset = pc.channels[2] as FakeChannel & { onopen?: () => void };
    expect(asset.label).toBe("yorishiro-call-avatar-v1");
    expect(asset.ordered).toBe(true);
    expect(asset.maxRetransmits).toBeNull();
    expect(call.sendAsset(new ArrayBuffer(10))).toBe(false);
    asset.readyState = "open";
    asset.onopen?.();
    expect(onAssetOpen).toHaveBeenCalledOnce();
    expect(call.sendAsset(new ArrayBuffer(16384))).toBe(true);
    asset.bufferedAmount = 65536;
    expect(call.sendAsset(new ArrayBuffer(10))).toBe(false);
    asset.onmessage?.({ data: "not binary" });
    asset.onmessage?.({ data: new ArrayBuffer(32769) });
    expect(onAsset).not.toHaveBeenCalled();
    const packet = new ArrayBuffer(16384);
    asset.onmessage?.({ data: packet });
    expect(onAsset).toHaveBeenCalledExactlyOnceWith(packet);
    call.close();
    expect(asset.close).toHaveBeenCalledOnce();
    expect(call.sendAsset(packet)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerCallConnectionOptions } from "./peer-connection";

const fakes = vi.hoisted(() => ({
  connections: [] as {
    options: PeerCallConnectionOptions;
    sendControl: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    setAudioTrack: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
  }[],
  audios: [] as {
    stopAgent: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    setAgent: ReturnType<typeof vi.fn>;
    setRemote: ReturnType<typeof vi.fn>;
    prepare: ReturnType<typeof vi.fn>;
    getAgentInput: ReturnType<typeof vi.fn>;
    microphoneActive: boolean;
  }[],
}));
vi.mock("./peer-connection", () => ({
  PeerCallConnection: class {
    sendControl = vi.fn(() => true);
    sendMotion = vi.fn();
    close = vi.fn();
    setAudioTrack = vi.fn();
    getStats = vi.fn(async () => new Map());
    constructor(readonly options: PeerCallConnectionOptions) {
      fakes.connections.push(this);
    }
  },
}));
vi.mock("./room-audio", () => ({
  RoomAudio: class {
    microphoneActive = false;
    stopAgent = vi.fn();
    close = vi.fn();
    setAgent = vi.fn(async () => {});
    setRemote = vi.fn();
    prepare = vi.fn(async () => ({
      agent: { stop: vi.fn() } as unknown as MediaStreamTrack,
      human: { stop: vi.fn() } as unknown as MediaStreamTrack,
    }));
    setOutput = vi.fn();
    getAgentInput = vi.fn(() => ({}) as MediaStream);
    constructor() {
      fakes.audios.push(this);
    }
  },
}));

import { CallPeer } from "./call-peer";

let peer: CallPeer;
const consent = (revision: number, allowRemoteAi = true) =>
  JSON.stringify({
    version: 1,
    revision,
    name: "Remote",
    allowRemoteAi,
    aiActive: false,
    microphoneActive: false,
  });
beforeEach(() => {
  vi.useFakeTimers();
  fakes.connections = [];
  fakes.audios = [];
  peer = new CallPeer("Local", () => null, vi.fn());
});
afterEach(() => {
  peer.close();
  vi.useRealTimers();
});
function connect() {
  fakes.connections[0].options.onState?.("connected");
  fakes.connections[0].options.onControlOpen?.();
}
describe("native call boundary", () => {
  it("prepares both dedicated outgoing sources before negotiation", async () => {
    await peer.prepare();
    const tracks = await fakes.audios[0].prepare.mock.results[0].value;
    expect(fakes.connections[0].setAudioTrack.mock.calls).toEqual([
      [tracks.human, "human"],
      [tracks.agent, "agent"],
    ]);
  });
  it("keeps classified human and AI receive paths separate and consent-gates their provider mix", () => {
    connect();
    const receive = vi.fn();
    peer.onInputAudio(receive);
    const input = {} as MediaStream;
    fakes.audios[0].getAgentInput.mockReturnValue(input);
    const human = {} as MediaStream;
    const agent = {} as MediaStream;
    fakes.connections[0].options.onRemoteStream?.(human, "human");
    fakes.connections[0].options.onRemoteStream?.(agent, "agent");
    expect(fakes.audios[0].setRemote.mock.calls).toEqual([
      ["human", human],
      ["agent", agent],
    ]);
    expect(receive.mock.calls.every(([value]) => value === null)).toBe(true);
    fakes.connections[0].options.onControl?.(consent(1));
    expect(receive).toHaveBeenLastCalledWith(input);
    fakes.connections[0].options.onRemoteStream?.({} as MediaStream, "unknown");
    expect(fakes.audios[0].setRemote).toHaveBeenCalledTimes(2);
    fakes.connections[0].options.onControl?.(consent(2, false));
    expect(receive).toHaveBeenLastCalledWith(null);
  });
  it("sums independent inbound byte deltas regardless of track order and removes ended track baselines", async () => {
    const report = (
      entries: { id: string; bytes: number; jitter: number; samples: number; concealed: number }[],
      timestamp: number,
    ) =>
      new Map(
        entries.map((entry) => [
          entry.id,
          {
            id: entry.id,
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: entry.bytes,
            timestamp,
            jitter: entry.jitter,
            totalSamplesReceived: entry.samples,
            concealedSamples: entry.concealed,
          },
        ]),
      );
    connect();
    fakes.connections[0].options.onControl?.(consent(1));
    fakes.connections[0].getStats.mockResolvedValueOnce(
      report(
        [
          { id: "human", bytes: 1000, jitter: 0.01, samples: 100, concealed: 10 },
          { id: "agent", bytes: 5000, jitter: 0.03, samples: 300, concealed: 0 },
        ],
        1000,
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.metrics).toMatchObject({ jitterMs: 30, concealedPercent: 2.5 });
    fakes.connections[0].getStats.mockResolvedValueOnce(
      report(
        [
          { id: "agent", bytes: 8000, jitter: 0.02, samples: 300, concealed: 0 },
          { id: "human", bytes: 2000, jitter: 0.01, samples: 100, concealed: 10 },
        ],
        2000,
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.metrics).toMatchObject({ receivedKbps: 32, jitterMs: 20, concealedPercent: 2.5 });
    fakes.connections[0].getStats.mockResolvedValueOnce(
      report([{ id: "agent", bytes: 9000, jitter: 0, samples: 100, concealed: 0 }], 3000),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.metrics.receivedKbps).toBe(8);
    fakes.connections[0].getStats.mockResolvedValueOnce(
      report([{ id: "human", bytes: 100000, jitter: 0, samples: 100, concealed: 0 }], 4000),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.metrics.receivedKbps).toBeUndefined();
  });
  it("never gives incoming audio to AI without peer consent", () => {
    connect();
    const receive = vi.fn();
    peer.onRemoteAudio(receive);
    const stream = {} as MediaStream;
    fakes.connections[0].options.onRemoteStream?.(stream, "agent");
    expect(receive.mock.calls.every(([value]) => value === null)).toBe(true);
    fakes.connections[0].options.onControl?.(consent(1));
    expect(receive).toHaveBeenLastCalledWith(stream);
  });
  it("does not restart a provider input for every participant heartbeat", () => {
    connect();
    const stream = {} as MediaStream;
    fakes.connections[0].options.onRemoteStream?.(stream, "agent");
    fakes.connections[0].options.onControl?.(consent(1));
    const receive = vi.fn();
    peer.onRemoteAudio(receive);
    expect(receive).toHaveBeenCalledOnce();
    fakes.connections[0].options.onControl?.(consent(2));
    expect(receive).toHaveBeenCalledOnce();
  });
  it("revokes the audio before notifying controller and ignores stale permission", async () => {
    connect();
    fakes.connections[0].options.onControl?.(consent(3));
    const order: string[] = [];
    peer.onRemoteAudio((stream) => {
      if (stream === null) order.push("detached");
    });
    peer.onPermissionRevoked(() => order.push("revoked"));
    order.length = 0;
    fakes.connections[0].options.onControl?.(consent(4, false));
    expect(order.slice(0, 2)).toEqual(["detached", "revoked"]);
    expect(fakes.audios[0].stopAgent).toHaveBeenCalled();
    fakes.connections[0].options.onControl?.(consent(3, true));
    expect(peer.remote?.allowRemoteAi).toBe(false);
    await expect(peer.startAgentOutput({} as MediaStream)).rejects.toThrow();
  });
  it("does not revive AI output when sharing is revoked during attachment", async () => {
    connect();
    fakes.connections[0].options.onControl?.(consent(1));
    let resolve: () => void = () => {};
    fakes.audios[0].setAgent.mockImplementation(
      () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    );
    const attach = peer.startAgentOutput({} as MediaStream);
    fakes.connections[0].options.onControl?.(consent(2, false));
    resolve();
    await expect(attach).rejects.toThrow();
    expect(peer.aiActive).toBe(false);
  });
  it("closes all media and listeners on loss of transport control", () => {
    connect();
    const ended = vi.fn();
    peer.onClose(ended);
    fakes.connections[0].options.onControlClose?.();
    expect(peer.closed).toBe(true);
    expect(fakes.audios[0].close).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
    peer.close();
    expect(ended).toHaveBeenCalledOnce();
  });
  it("closes a peer that floods the reliable participant channel", () => {
    connect();
    for (let revision = 0; revision < 45; revision++)
      fakes.connections[0].options.onControl?.(consent(revision));
    expect(peer.closed).toBe(true);
  });
  it("times out missing participant consent even when the channel opened", () => {
    fakes.connections[0].options.onControlOpen?.();
    fakes.connections[0].options.onState?.("connected");
    vi.advanceTimersByTime(10_001);
    expect(peer.closed).toBe(true);
  });
});

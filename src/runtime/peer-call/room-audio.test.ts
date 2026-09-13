import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomAudio } from "./room-audio";

class Track {
  kind = "audio";
  readyState = "live";
  enabled = true;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  clones: Track[] = [];
  clone() {
    const copy = new Track();
    this.clones.push(copy);
    return copy;
  }
}
class Stream {
  constructor(readonly tracks: Track[] = [new Track()]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}
class Node {
  readonly inputs = new Set<Node>();
  readonly outputs = new Set<Node>();
  amplitude = 0;
  connect = vi.fn((node: Node) => {
    this.outputs.add(node);
    node.inputs.add(this);
    return node;
  });
  disconnect = vi.fn(() => {
    for (const node of this.outputs) node.inputs.delete(this);
    this.outputs.clear();
  });
  fftSize = 512;
  gain = { value: 1 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  private signal(): number {
    return (
      (this.amplitude + [...this.inputs].reduce((value, input) => value + input.signal(), 0)) *
      this.gain.value
    );
  }
  getFloatTimeDomainData(data: Float32Array) {
    data.fill(this.signal());
  }
}
class Context {
  static all: Context[] = [];
  state = "running";
  destination = new Node();
  sources: { stream: Stream; node: Node }[] = [];
  gains: Node[] = [];
  destinations: (Node & { stream: Stream })[] = [];
  compressors: Node[] = [];
  get output() {
    return this.destinations[0];
  }
  get compressor() {
    return this.compressors[0];
  }
  get humanOutput() {
    return this.destinations[1];
  }
  get agentInput() {
    return this.destinations[2];
  }
  get humanMixer() {
    return this.compressors[1];
  }
  get inputMixer() {
    return this.compressors[2];
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  constructor() {
    Context.all.push(this);
  }
  createMediaStreamDestination() {
    const node = Object.assign(new Node(), { stream: new Stream() });
    this.destinations.push(node);
    return node;
  }
  createDynamicsCompressor() {
    const node = new Node();
    this.compressors.push(node);
    return node;
  }
  createMediaStreamSource(stream: Stream) {
    const node = new Node();
    node.amplitude = 0.04;
    this.sources.push({ stream, node });
    return node;
  }
  createAnalyser() {
    return new Node();
  }
  createGain() {
    const node = new Node();
    this.gains.push(node);
    return node;
  }
}
const asStream = (stream: Stream) => stream as unknown as MediaStream;
function reaches(source: Node, target: Node, seen = new Set<Node>()): boolean {
  if (source === target) return true;
  if (seen.has(source)) return false;
  seen.add(source);
  return [...source.outputs].some((node) => reaches(node, target, seen));
}
let audio: RoomAudio;
let getUserMedia = vi.fn();
beforeEach(() => {
  Context.all = [];
  getUserMedia = vi.fn();
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  audio = new RoomAudio(true);
});
afterEach(() => {
  audio.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("native room audio ownership and consent", () => {
  it("prepares two stable silent senders without opening a microphone", async () => {
    const first = await audio.prepare();
    expect(await audio.prepare()).toBe(first);
    expect(first.agent).not.toBe(first.human);
    expect(first.agent).toBe(Context.all[0].output.stream.tracks[0]);
    expect(first.human).toBe(Context.all[0].humanOutput.stream.tracks[0]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("sends microphone and AI on separate tracks and only monitors the local AI", async () => {
    const mic = new Stream();
    const agent = new Stream();
    getUserMedia.mockResolvedValue(mic);
    await audio.setMicrophone(true);
    await audio.setAgent(asStream(agent));
    await audio.setOutput(true);
    const context = Context.all[0];
    const humanSource = context.sources[0].node;
    const agentSource = context.sources[1].node;
    expect(reaches(humanSource, context.humanOutput)).toBe(true);
    expect(reaches(humanSource, context.output)).toBe(false);
    expect(reaches(humanSource, context.destination)).toBe(false);
    expect(reaches(agentSource, context.output)).toBe(true);
    expect(reaches(agentSource, context.humanOutput)).toBe(false);
    expect(reaches(agentSource, context.destination)).toBe(true);
    expect(context.gains[0].gain.value).toBe(1);
    audio.stopAgent();
    expect(agent.tracks[0].stop).not.toHaveBeenCalled();
    expect(agent.tracks[0].clones[0].stop).toHaveBeenCalled();
    expect(mic.tracks[0].stop).not.toHaveBeenCalled();
    expect(audio.microphoneActive).toBe(true);
    expect(context.humanOutput.stream.tracks[0].readyState).toBe("live");
    expect(context.output.stream.tracks[0].readyState).toBe("live");
  });
  it("feeds each AI the human and remote audio, excluding its own voice from that input", async () => {
    const mic = new Stream();
    const remoteAgent = new Stream();
    const remoteHuman = new Stream();
    const agent = new Stream();
    getUserMedia.mockResolvedValue(mic);
    await audio.setMicrophone(true);
    audio.setRemote("agent", asStream(remoteAgent));
    audio.setRemote("human", asStream(remoteHuman));
    await audio.setAgent(asStream(agent));
    const context = Context.all[0];
    expect(audio.getAgentInput()).toBe(context.agentInput.stream);
    for (const source of context.sources.slice(0, 3)) {
      expect(reaches(source.node, context.agentInput)).toBe(true);
    }
    for (const source of context.sources.slice(1, 3)) {
      expect(reaches(source.node, context.output)).toBe(false);
      expect(reaches(source.node, context.humanOutput)).toBe(false);
    }
    expect(reaches(context.sources[3].node, context.agentInput)).toBe(false);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: false,
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audio.close();
    expect(audio.getAgentInput()).toBeNull();
    expect(context.destinations.every((node) => node.stream.tracks[0].readyState === "ended")).toBe(
      true,
    );
    expect(remoteAgent.tracks[0].stop).not.toHaveBeenCalled();
    expect(remoteHuman.tracks[0].stop).not.toHaveBeenCalled();
    expect(agent.tracks[0].stop).not.toHaveBeenCalled();
  });
  it("plays both remote voices but moves the remote mouth only for AI audio", async () => {
    const remoteHuman = new Stream();
    const remoteAgent = new Stream();
    audio.setRemote("human", asStream(remoteHuman));
    await audio.setOutput(true);
    const context = Context.all[0];
    const humanSource = context.sources[0].node;
    humanSource.amplitude = 0.6;
    expect(reaches(humanSource, context.destination)).toBe(true);
    expect(reaches(humanSource, context.agentInput)).toBe(true);
    expect(audio.sampleRemoteMouth()).toBe(0);

    audio.setRemote("agent", asStream(remoteAgent));
    const agentSource = context.sources[1].node;
    agentSource.amplitude = 0;
    expect(reaches(agentSource, context.destination)).toBe(true);
    expect(audio.sampleRemoteMouth()).toBe(0);
    agentSource.amplitude = 0.04;
    const mouth = audio.sampleRemoteMouth();
    expect(mouth).toBeGreaterThan(0);
    humanSource.amplitude = 1;
    expect(audio.sampleRemoteMouth()).toBe(mouth);

    await audio.setOutput(false);
    expect(context.gains.every((gain) => gain.gain.value === 0)).toBe(true);
    audio.setRemote("agent", null);
    expect(agentSource.disconnect).toHaveBeenCalledOnce();
    expect(humanSource.disconnect).not.toHaveBeenCalled();
    expect(audio.sampleRemoteMouth()).toBe(0);
    expect(remoteAgent.tracks[0].stop).not.toHaveBeenCalled();
  });
  it("replaces one remote route without disturbing the other or stopping borrowed tracks", async () => {
    await audio.prepare();
    const agent = new Stream();
    const human = new Stream();
    const replacement = new Stream();
    audio.setRemote("agent", asStream(agent));
    audio.setRemote("human", asStream(human));
    const context = Context.all[0];
    const mouth = audio.sampleRemoteMouth();
    audio.setRemote("human", asStream(replacement));
    expect(context.sources[0].node.disconnect).not.toHaveBeenCalled();
    expect(context.sources[1].node.disconnect).toHaveBeenCalledOnce();
    expect(reaches(context.sources[1].node, context.agentInput)).toBe(false);
    expect(reaches(context.sources[2].node, context.agentInput)).toBe(true);
    expect(audio.sampleRemoteMouth()).toBe(mouth);
    audio.close();
    for (const stream of [agent, human, replacement]) {
      expect(stream.tracks[0].stop).not.toHaveBeenCalled();
    }
    expect(context.sources.every(({ node }) => node.outputs.size === 0)).toBe(true);
  });
  it("revokes the microphone without ending or replacing the AI sender", async () => {
    const mic = new Stream();
    const agent = new Stream();
    getUserMedia.mockResolvedValue(mic);
    const senders = await audio.prepare();
    await audio.setAgent(asStream(agent));
    await audio.setMicrophone(true);
    const context = Context.all[0];
    context.sources[0].node.amplitude = 0.02;
    context.sources[1].node.amplitude = 0.8;
    const mouth = audio.sampleLocalMouth();
    expect(mouth).toBeCloseTo((0.02 - 0.006) * 9);
    await audio.setMicrophone(false);
    expect(audio.sampleLocalMouth()).toBe(mouth);
    expect(await audio.prepare()).toBe(senders);
    expect(senders.agent.readyState).toBe("live");
    expect(senders.human.readyState).toBe("live");
    expect(mic.tracks[0].stop).toHaveBeenCalled();
    expect(agent.tracks[0].clones[0].stop).not.toHaveBeenCalled();
    expect(audio.microphoneRequested).toBe(false);
  });
  it("drops late microphone permission after revoke without altering AI output", async () => {
    let resolve: (stream: Stream) => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise<Stream>((yes) => {
        resolve = yes;
      }),
    );
    const request = audio.setMicrophone(true);
    await Promise.resolve();
    await Promise.resolve();
    const agent = new Stream();
    await audio.setAgent(asStream(agent));
    audio.stopMicrophone();
    const mic = new Stream();
    resolve(mic);
    await request;
    expect(mic.tracks[0].stop).toHaveBeenCalled();
    expect(audio.microphoneActive).toBe(false);
    expect(agent.tracks[0].clones[0].stop).not.toHaveBeenCalled();
  });
  it("does not stop borrowed received audio or provider track on hangup", async () => {
    const remote = new Stream();
    const agent = new Stream();
    audio.setRemote("agent", asStream(remote));
    await audio.setAgent(asStream(agent));
    audio.close();
    expect(remote.tracks[0].stop).not.toHaveBeenCalled();
    expect(agent.tracks[0].stop).not.toHaveBeenCalled();
    expect(Context.all[0].output.stream.tracks[0].stop).toHaveBeenCalled();
    expect(Context.all[0].close).toHaveBeenCalledOnce();
  });
  it("does not allow delayed speaker activation to override mute", async () => {
    await audio.prepare();
    const context = Context.all[0];
    audio.setRemote("agent", asStream(new Stream()));
    audio.setRemote("human", asStream(new Stream()));
    context.state = "suspended";
    let finish: () => void = () => {};
    context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            context.state = "running";
            resolve();
          };
        }),
    );
    const enable = audio.setOutput(true);
    await audio.setOutput(false);
    finish();
    await enable;
    expect(context.gains.every((gain) => gain.gain.value === 0)).toBe(true);
  });
  it("allows a direct retry after microphone permission fails", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("permission denied"));
    await expect(audio.setMicrophone(true)).rejects.toThrow("permission denied");
    expect(audio.microphoneRequested).toBe(false);
    const mic = new Stream();
    getUserMedia.mockResolvedValueOnce(mic);
    await audio.setMicrophone(true);
    expect(audio.microphoneActive).toBe(true);
  });
  it("does not locally replay AI in the two-endpoint same-device room", async () => {
    audio.close();
    audio = new RoomAudio(false);
    await audio.setAgent(asStream(new Stream()));
    await audio.setOutput(true);
    expect(Context.all[0].gains[0].gain.value).toBe(0);
  });
});

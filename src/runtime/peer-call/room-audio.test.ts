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
  connect = vi.fn();
  disconnect = vi.fn();
  fftSize = 512;
  gain = { value: 1 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  getFloatTimeDomainData(data: Float32Array) {
    data.fill(0.04);
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
  it("prepares a silent sender without opening a microphone", async () => {
    const first = await audio.prepare();
    expect(await audio.prepare()).toBe(first);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("mixes independent microphone and AI tracks and only monitors the AI", async () => {
    const mic = new Stream();
    const agent = new Stream();
    getUserMedia.mockResolvedValue(mic);
    await audio.setMicrophone(true);
    await audio.setAgent(asStream(agent));
    await audio.setOutput(true);
    const context = Context.all[0];
    expect(context.sources[0].node.connect).toHaveBeenCalledWith(context.compressor);
    expect(context.sources[0].node.connect).not.toHaveBeenCalledWith(context.destination);
    expect(context.gains[0].gain.value).toBe(1);
    audio.stopAgent();
    expect(agent.tracks[0].stop).not.toHaveBeenCalled();
    expect(agent.tracks[0].clones[0].stop).toHaveBeenCalled();
    expect(mic.tracks[0].stop).not.toHaveBeenCalled();
    expect(audio.microphoneActive).toBe(true);
  });
  it("feeds each AI the human and remote audio, excluding its own voice from that input", async () => {
    const mic = new Stream();
    const remote = new Stream();
    const agent = new Stream();
    getUserMedia.mockResolvedValue(mic);
    await audio.setMicrophone(true);
    audio.setRemote(asStream(remote));
    await audio.setAgent(asStream(agent));
    const context = Context.all[0];
    const inputMixer = context.compressors[1];
    expect(audio.getAgentInput()).toBe(context.destinations[1].stream);
    expect(context.sources[0].node.connect).toHaveBeenCalledWith(inputMixer);
    expect(context.sources[1].node.connect).toHaveBeenCalledWith(inputMixer);
    expect(context.sources[1].node.connect).not.toHaveBeenCalledWith(context.compressor);
    expect(context.sources[2].node.connect).not.toHaveBeenCalledWith(inputMixer);
    expect(inputMixer.connect).toHaveBeenCalledWith(context.destinations[1]);
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
    expect(remote.tracks[0].stop).not.toHaveBeenCalled();
    expect(agent.tracks[0].stop).not.toHaveBeenCalled();
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
    audio.setRemote(asStream(remote));
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
    audio.setRemote(asStream(new Stream()));
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

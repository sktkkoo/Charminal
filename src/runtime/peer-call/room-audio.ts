export type RoomAudioKind = "agent" | "human";

export interface RoomAudioTracks {
  readonly agent: MediaStreamTrack;
  readonly human: MediaStreamTrack;
}

interface RemoteAudioNodes {
  readonly source: MediaStreamAudioSourceNode;
  readonly analyser: AnalyserNode | null;
  readonly gain: GainNode;
}

/** Owned call audio. Human and AI senders stay separate throughout transport and playback. */
export class RoomAudio {
  private context: AudioContext | null = null;
  private agentOutput: MediaStreamAudioDestinationNode | null = null;
  private humanOutput: MediaStreamAudioDestinationNode | null = null;
  private outputTracks: RoomAudioTracks | null = null;
  private agentInput: MediaStreamAudioDestinationNode | null = null;
  private agentInputMixer: DynamicsCompressorNode | null = null;
  private agentMixer: DynamicsCompressorNode | null = null;
  private humanMixer: DynamicsCompressorNode | null = null;
  private microphone: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private agent: MediaStream | null = null;
  private agentSource: MediaStreamAudioSourceNode | null = null;
  private agentAnalyser: AnalyserNode | null = null;
  private agentMonitor: GainNode | null = null;
  private readonly remoteStreams = new Map<RoomAudioKind, MediaStream>();
  private readonly remoteNodes = new Map<RoomAudioKind, RemoteAudioNodes>();
  microphoneRequested = false;
  private microphoneRevision = 0;
  private agentRevision = 0;
  private outputRevision = 0;
  private closed = false;
  private outputEnabled = false;
  private readonly samples = new Float32Array(512);
  private readonly pending = new Set<() => void>();

  constructor(private readonly monitorAgent: boolean) {}

  /** Stable silent tracks are negotiated before either input is enabled; no microphone prompt. */
  async prepare(): Promise<RoomAudioTracks> {
    if (this.closed) throw new Error("Call audio is closed");
    if (!this.context) {
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      this.agentOutput = context.createMediaStreamDestination();
      this.humanOutput = context.createMediaStreamDestination();
      this.agentInput = context.createMediaStreamDestination();
      this.agentMixer = context.createDynamicsCompressor();
      this.humanMixer = context.createDynamicsCompressor();
      this.agentInputMixer = context.createDynamicsCompressor();
      for (const mixer of [this.agentMixer, this.humanMixer, this.agentInputMixer]) {
        mixer.threshold.value = -3;
        mixer.knee.value = 6;
        mixer.ratio.value = 4;
        mixer.attack.value = 0.003;
        mixer.release.value = 0.1;
      }
      this.agentInputMixer.connect(this.agentInput);
      this.agentMixer.connect(this.agentOutput);
      this.humanMixer.connect(this.humanOutput);
      for (const kind of this.remoteStreams.keys()) this.connectRemote(kind);
    }
    const context = this.context;
    if (context.state !== "running") {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          this.pending.delete(cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => finish(new Error("Call audio was cancelled"));
        const timer = setTimeout(() => {
          finish(new Error("Audio startup timed out"));
          this.close();
        }, 8000);
        this.pending.add(cancel);
        void context.resume().then(
          () => finish(),
          () => finish(new Error("Audio playback failed")),
        );
      });
    }
    if (this.closed || context.state !== "running") throw new Error("Call audio is unavailable");
    if (!this.outputTracks) {
      const agent = this.agentOutput?.stream.getAudioTracks()[0];
      const human = this.humanOutput?.stream.getAudioTracks()[0];
      if (!agent || !human) throw new Error("Audio sender is unavailable");
      this.outputTracks = { agent, human };
    }
    return this.outputTracks;
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    this.stopMicrophone();
    if (!enabled || this.closed) return;
    this.microphoneRequested = true;
    const revision = this.microphoneRevision;
    try {
      await this.prepare();
      if (revision !== this.microphoneRevision || this.closed) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (revision !== this.microphoneRevision || this.closed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.microphone = stream;
      const { context, humanMixer } = this.graph();
      this.micSource = context.createMediaStreamSource(stream);
      this.micSource.connect(humanMixer);
      if (this.agentInputMixer) this.micSource.connect(this.agentInputMixer);
    } catch (error) {
      if (revision === this.microphoneRevision) this.stopMicrophone();
      throw error;
    }
  }

  get microphoneActive(): boolean {
    return (
      this.microphone
        ?.getAudioTracks()
        .some((track) => track.readyState === "live" && track.enabled) ?? false
    );
  }

  /** Borrowed stream: local human + both peer voices, never this resident's own AI output. */
  getAgentInput(): MediaStream | null {
    return this.closed ? null : (this.agentInput?.stream ?? null);
  }

  stopMicrophone(): void {
    ++this.microphoneRevision;
    this.microphoneRequested = false;
    this.micSource?.disconnect();
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    this.micSource = null;
    this.microphone = null;
  }

  async setAgent(stream: MediaStream): Promise<void> {
    this.stopAgent();
    const revision = this.agentRevision;
    await this.prepare();
    if (this.closed || revision !== this.agentRevision)
      throw new Error("Agent audio was cancelled");
    const track = stream.getAudioTracks().find((item) => item.readyState === "live");
    if (!track) throw new Error("Agent did not provide live audio");
    const owned = track.clone();
    try {
      const { context, agentMixer } = this.graph();
      this.agent = new MediaStream([owned]);
      this.agentSource = context.createMediaStreamSource(this.agent);
      this.agentAnalyser = context.createAnalyser();
      this.agentAnalyser.fftSize = 512;
      this.agentMonitor = context.createGain();
      this.agentMonitor.gain.value = this.monitorAgent && this.outputEnabled ? 1 : 0;
      this.agentSource.connect(this.agentAnalyser);
      this.agentAnalyser.connect(agentMixer);
      this.agentAnalyser.connect(this.agentMonitor);
      this.agentMonitor.connect(context.destination);
    } catch (error) {
      owned.stop();
      this.stopAgent();
      throw error;
    }
  }

  stopAgent(): void {
    ++this.agentRevision;
    this.agentSource?.disconnect();
    this.agentAnalyser?.disconnect();
    this.agentMonitor?.disconnect();
    for (const track of this.agent?.getTracks() ?? []) track.stop();
    this.agent = null;
    this.agentSource = null;
    this.agentAnalyser = null;
    this.agentMonitor = null;
  }

  setRemote(kind: RoomAudioKind, stream: MediaStream | null): void {
    if (this.closed) return;
    this.disconnectRemote(kind);
    if (stream) this.remoteStreams.set(kind, stream);
    else this.remoteStreams.delete(kind);
    this.connectRemote(kind);
  }

  async setOutput(enabled: boolean): Promise<void> {
    const revision = ++this.outputRevision;
    if (!enabled) {
      this.outputEnabled = false;
      this.applyOutput();
      return;
    }
    await this.prepare();
    if (this.closed || revision !== this.outputRevision) return;
    this.outputEnabled = true;
    this.applyOutput();
  }

  sampleLocalMouth(): number {
    return this.sample(this.agentAnalyser);
  }
  sampleRemoteMouth(): number {
    return this.sample(this.remoteNodes.get("agent")?.analyser ?? null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.outputRevision;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
    this.stopMicrophone();
    this.stopAgent();
    for (const kind of this.remoteNodes.keys()) this.disconnectRemote(kind);
    this.remoteStreams.clear();
    this.agentMixer?.disconnect();
    this.humanMixer?.disconnect();
    this.agentInputMixer?.disconnect();
    for (const track of this.agentOutput?.stream.getTracks() ?? []) track.stop();
    for (const track of this.humanOutput?.stream.getTracks() ?? []) track.stop();
    for (const track of this.agentInput?.stream.getTracks() ?? []) track.stop();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.agentOutput = null;
    this.humanOutput = null;
    this.outputTracks = null;
    this.agentInput = null;
    this.agentInputMixer = null;
    this.agentMixer = null;
    this.humanMixer = null;
  }

  private graph(): {
    context: AudioContext;
    agentMixer: DynamicsCompressorNode;
    humanMixer: DynamicsCompressorNode;
  } {
    if (this.closed || !this.context || !this.agentMixer || !this.humanMixer)
      throw new Error("Call audio is unavailable");
    return { context: this.context, agentMixer: this.agentMixer, humanMixer: this.humanMixer };
  }

  private applyOutput(): void {
    for (const { gain } of this.remoteNodes.values()) gain.gain.value = this.outputEnabled ? 1 : 0;
    if (this.agentMonitor)
      this.agentMonitor.gain.value = this.outputEnabled && this.monitorAgent ? 1 : 0;
  }

  private connectRemote(kind: RoomAudioKind): void {
    const stream = this.remoteStreams.get(kind);
    if (!this.context || !stream || this.remoteNodes.has(kind)) return;
    const source = this.context.createMediaStreamSource(stream);
    const analyser = kind === "agent" ? this.context.createAnalyser() : null;
    const gain = this.context.createGain();
    this.remoteNodes.set(kind, { source, analyser, gain });
    if (analyser) {
      analyser.fftSize = 512;
      source.connect(analyser);
      analyser.connect(gain);
    } else source.connect(gain);
    if (this.agentInputMixer) source.connect(this.agentInputMixer);
    gain.connect(this.context.destination);
    this.applyOutput();
  }

  private disconnectRemote(kind: RoomAudioKind): void {
    const nodes = this.remoteNodes.get(kind);
    nodes?.source.disconnect();
    nodes?.analyser?.disconnect();
    nodes?.gain.disconnect();
    this.remoteNodes.delete(kind);
  }

  private sample(analyser: AnalyserNode | null): number {
    if (!analyser || this.closed) return 0;
    analyser.getFloatTimeDomainData(this.samples);
    let power = 0;
    for (const value of this.samples) power += value * value;
    return Math.min(1, Math.max(0, (Math.sqrt(power / this.samples.length) - 0.006) * 9));
  }
}

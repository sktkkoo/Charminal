/** Owned call mixer. The microphone and AI output have independent lifetimes. */
export class RoomAudio {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private agentInput: MediaStreamAudioDestinationNode | null = null;
  private agentInputMixer: DynamicsCompressorNode | null = null;
  private mixer: DynamicsCompressorNode | null = null;
  private microphone: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private agent: MediaStream | null = null;
  private agentSource: MediaStreamAudioSourceNode | null = null;
  private agentAnalyser: AnalyserNode | null = null;
  private agentMonitor: GainNode | null = null;
  private remote: MediaStream | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private remoteGain: GainNode | null = null;
  microphoneRequested = false;
  private microphoneRevision = 0;
  private agentRevision = 0;
  private outputRevision = 0;
  private closed = false;
  private outputEnabled = false;
  private readonly samples = new Float32Array(512);
  private readonly pending = new Set<() => void>();

  constructor(private readonly monitorAgent: boolean) {}

  async prepare(): Promise<MediaStreamTrack> {
    if (this.closed) throw new Error("Call audio is closed");
    if (!this.context) {
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      this.destination = context.createMediaStreamDestination();
      this.agentInput = context.createMediaStreamDestination();
      this.mixer = context.createDynamicsCompressor();
      this.agentInputMixer = context.createDynamicsCompressor();
      for (const mixer of [this.mixer, this.agentInputMixer]) {
        mixer.threshold.value = -3;
        mixer.knee.value = 6;
        mixer.ratio.value = 4;
        mixer.attack.value = 0.003;
        mixer.release.value = 0.1;
      }
      this.agentInputMixer.connect(this.agentInput);
      this.mixer.connect(this.destination);
      this.connectRemote();
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
    const track = this.destination?.stream.getAudioTracks()[0];
    if (!track) throw new Error("Audio sender is unavailable");
    return track;
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
      const { context, mixer } = this.graph();
      this.micSource = context.createMediaStreamSource(stream);
      this.micSource.connect(mixer);
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

  /** Borrowed stream: human microphone + peer, never this resident's own output. */
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
      const { context, mixer } = this.graph();
      this.agent = new MediaStream([owned]);
      this.agentSource = context.createMediaStreamSource(this.agent);
      this.agentAnalyser = context.createAnalyser();
      this.agentAnalyser.fftSize = 512;
      this.agentMonitor = context.createGain();
      this.agentMonitor.gain.value = this.monitorAgent && this.outputEnabled ? 1 : 0;
      this.agentSource.connect(this.agentAnalyser);
      this.agentAnalyser.connect(mixer);
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

  setRemote(stream: MediaStream): void {
    if (this.closed) return;
    this.disconnectRemote();
    this.remote = stream;
    this.connectRemote();
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
    return this.sample(this.remoteAnalyser);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.outputRevision;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
    this.stopMicrophone();
    this.stopAgent();
    this.disconnectRemote();
    this.remote = null;
    this.mixer?.disconnect();
    this.agentInputMixer?.disconnect();
    for (const track of this.destination?.stream.getTracks() ?? []) track.stop();
    for (const track of this.agentInput?.stream.getTracks() ?? []) track.stop();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.destination = null;
    this.agentInput = null;
    this.agentInputMixer = null;
    this.mixer = null;
  }

  private graph(): { context: AudioContext; mixer: DynamicsCompressorNode } {
    if (this.closed || !this.context || !this.mixer) throw new Error("Call audio is unavailable");
    return { context: this.context, mixer: this.mixer };
  }

  private applyOutput(): void {
    if (this.remoteGain) this.remoteGain.gain.value = this.outputEnabled ? 1 : 0;
    if (this.agentMonitor)
      this.agentMonitor.gain.value = this.outputEnabled && this.monitorAgent ? 1 : 0;
  }

  private connectRemote(): void {
    if (!this.context || !this.remote || this.remoteSource) return;
    this.remoteSource = this.context.createMediaStreamSource(this.remote);
    this.remoteAnalyser = this.context.createAnalyser();
    this.remoteAnalyser.fftSize = 512;
    this.remoteGain = this.context.createGain();
    this.remoteSource.connect(this.remoteAnalyser);
    if (this.agentInputMixer) this.remoteSource.connect(this.agentInputMixer);
    this.remoteAnalyser.connect(this.remoteGain);
    this.remoteGain.connect(this.context.destination);
    this.applyOutput();
  }

  private disconnectRemote(): void {
    this.remoteSource?.disconnect();
    this.remoteAnalyser?.disconnect();
    this.remoteGain?.disconnect();
    this.remoteSource = null;
    this.remoteAnalyser = null;
    this.remoteGain = null;
  }

  private sample(analyser: AnalyserNode | null): number {
    if (!analyser || this.closed) return 0;
    analyser.getFloatTimeDomainData(this.samples);
    let power = 0;
    for (const value of this.samples) power += value * value;
    return Math.min(1, Math.max(0, (Math.sqrt(power / this.samples.length) - 0.006) * 9));
  }
}

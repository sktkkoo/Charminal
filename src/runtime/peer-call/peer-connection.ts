export interface PeerCallConnectionOptions {
  iceServers?: RTCIceServer[];
  onState?: (state: RTCPeerConnectionState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onMotion?: (data: ArrayBuffer) => void;
  onError?: (error: Error) => void;
  /** Product call negotiation uses a separate reliable channel for participant consent. */
  onControl?: (data: string) => void;
  onControlOpen?: () => void;
  onControlClose?: () => void;
  productCall?: boolean;
  onAsset?: (data: ArrayBuffer) => void;
  onAssetOpen?: () => void;
}

interface SignalEnvelope {
  version: 1;
  roomId: string;
  type: "offer" | "answer";
  sdp: string;
}

class SupersededAudioChoice extends Error {
  constructor() {
    super("Audio choice was superseded");
  }
}

const MAX_SIGNAL_LENGTH = 128 * 1024;
const MAX_SDP_LENGTH = 64 * 1024;
const MAX_MOTION_BYTES = 16 * 1024;
const MAX_MOTION_BUFFER = 64 * 1024;
const ICE_TIMEOUT_MS = 30_000;
const MOTION_LABEL = "yorishiro-motion-v1";
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function readSignal(serialized: string, type: SignalEnvelope["type"]): SignalEnvelope {
  if (typeof serialized !== "string" || serialized.length > MAX_SIGNAL_LENGTH) {
    throw new Error("Invitation exceeds the size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Invitation is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invitation must be an object");
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 4 ||
    envelope.version !== 1 ||
    envelope.type !== type ||
    typeof envelope.roomId !== "string" ||
    !ROOM_ID.test(envelope.roomId) ||
    typeof envelope.sdp !== "string" ||
    envelope.sdp.length > MAX_SDP_LENGTH ||
    !/^v=0\r?\n/.test(envelope.sdp) ||
    envelope.sdp.includes("\0")
  ) {
    throw new Error("Unsupported or malformed invitation");
  }
  const media = envelope.sdp.split(/\r?\n/).filter((line) => line.startsWith("m="));
  if (
    media.length !== 2 ||
    media.filter((line) => line.startsWith("m=audio ")).length !== 1 ||
    media.filter((line) => line.startsWith("m=application ")).length !== 1
  ) {
    throw new Error("A call accepts one audio stream and one data transport only");
  }
  return envelope as unknown as SignalEnvelope;
}

/**
 * Single-use, manual-signaling transport for trusted invitations. Room IDs bind an
 * answer to this offer; they do not authenticate a person, endpoint, or AI owner.
 * WebRTC handles audio codecs, jitter, loss concealment, and transport encryption.
 * This class neither requests a microphone nor selects a hosted signaling/TURN service.
 */
export class PeerCallConnection {
  private readonly pc: RTCPeerConnection;
  private audio: RTCRtpTransceiver | null = null;
  private phase: "idle" | "negotiating" | "awaiting-answer" | "negotiated" = "idle";
  private closed = false;
  private roomId: string | null = null;
  private motion: RTCDataChannel | null = null;
  private control: RTCDataChannel | null = null;
  private asset: RTCDataChannel | null = null;
  private readonly pending = new Set<(error: Error) => void>();
  private readonly ownedTracks = new Set<MediaStreamTrack>();
  private readonly remoteTracks = new Set<MediaStreamTrack>();
  private localTrack: MediaStreamTrack | null = null;
  private desiredTrack: MediaStreamTrack | null = null;
  private audioRevision = 0;
  private audioQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PeerCallConnectionOptions = {}) {
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      this.options.onState?.(this.pc.connectionState);
      if (this.pc.connectionState === "failed") {
        this.fail(new Error("Peer connection failed; create a new invitation to retry"));
      }
    };
    this.pc.ontrack = (event) => {
      if (this.closed || event.track.kind !== "audio") {
        event.track.stop();
        return;
      }
      this.remoteTracks.add(event.track);
      this.options.onRemoteStream?.(new MediaStream([event.track]));
    };
    this.pc.ondatachannel = (event) => {
      if (options.productCall && event.channel.label === "yorishiro-call-control-v1") {
        this.attachControl(event.channel);
      } else if (options.productCall && event.channel.label === "yorishiro-call-avatar-v1") {
        this.attachAsset(event.channel);
      } else this.attachMotion(event.channel);
    };
  }

  async createOffer(): Promise<string> {
    this.assertPhase("idle");
    this.phase = "negotiating";
    try {
      this.roomId = crypto.randomUUID();
      this.initializeAudio(this.pc.addTransceiver("audio", { direction: "sendrecv" }));
      this.attachMotion(
        this.pc.createDataChannel(MOTION_LABEL, { ordered: false, maxRetransmits: 0 }),
      );
      if (this.options.productCall) {
        this.attachControl(
          this.pc.createDataChannel("yorishiro-call-control-v1", { ordered: true }),
        );
        this.attachAsset(this.pc.createDataChannel("yorishiro-call-avatar-v1", { ordered: true }));
      }
      const offer = await this.wait(this.pc.createOffer());
      this.assertOpen();
      await this.wait(this.pc.setLocalDescription(offer));
      await this.gatherIce();
      const serialized = this.localSignal("offer");
      this.phase = "awaiting-answer";
      return serialized;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async acceptOffer(serialized: string): Promise<string> {
    this.assertPhase("idle");
    const offer = readSignal(serialized, "offer");
    this.phase = "negotiating";
    this.roomId = offer.roomId;
    try {
      await this.wait(this.pc.setRemoteDescription({ type: "offer", sdp: offer.sdp }));
      this.assertOpen();
      // JSEP associates an incoming offer with its own transceiver. A pre-created
      // addTransceiver() sender is not necessarily reused on the answering side.
      const audio = this.pc.getTransceivers().find((item) => item.receiver.track.kind === "audio");
      if (!audio) throw new Error("Remote offer did not create an audio transceiver");
      this.initializeAudio(audio);
      const answer = await this.wait(this.pc.createAnswer());
      this.assertOpen();
      await this.wait(this.pc.setLocalDescription(answer));
      await this.gatherIce();
      const response = this.localSignal("answer");
      this.phase = "negotiated";
      return response;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async acceptAnswer(serialized: string): Promise<void> {
    this.assertPhase("awaiting-answer");
    const answer = readSignal(serialized, "answer");
    if (answer.roomId !== this.roomId) throw new Error("Answer belongs to a different invitation");
    this.phase = "negotiating";
    try {
      await this.wait(this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp }));
      this.assertOpen();
      this.phase = "negotiated";
    } catch (error) {
      throw this.fail(error);
    }
  }

  /**
   * A valid track is exclusively owned here once submitted, including queued updates.
   * Replaced/superseded tracks are stopped. Pass a dedicated track or clone, not a
   * shared microphone track. Passing null stops owned capture immediately.
   */
  async setAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    this.assertOpen();
    if (track && (track.kind !== "audio" || track.readyState !== "live")) {
      throw new Error("A live audio track is required");
    }
    const revision = ++this.audioRevision;
    this.desiredTrack = track;
    if (track) this.ownedTracks.add(track);
    else this.stopOwnedTracks();
    const audio = this.audio;
    if (!audio) {
      // Before choosing caller/answerer, retain the explicit source without
      // creating an unassociated transceiver that would break answering.
      this.releaseUnusedTracks();
      return;
    }

    const operation = this.audioQueue.then(async () => {
      try {
        this.assertOpen();
        if (revision !== this.audioRevision) throw new SupersededAudioChoice();
        await this.wait(audio.sender.replaceTrack(track));
        this.assertOpen();
        this.localTrack = track;
        if (revision !== this.audioRevision) throw new SupersededAudioChoice();
      } finally {
        if (revision === this.audioRevision) this.desiredTrack = this.localTrack;
        this.releaseUnusedTracks();
      }
    });
    this.audioQueue = operation.catch(() => {});
    return operation;
  }

  sendMotion(data: ArrayBuffer): boolean {
    const channel = this.motion;
    if (
      this.closed ||
      !channel ||
      channel.readyState !== "open" ||
      !(data instanceof ArrayBuffer) ||
      data.byteLength === 0 ||
      data.byteLength > MAX_MOTION_BYTES ||
      channel.bufferedAmount + data.byteLength > MAX_MOTION_BUFFER
    ) {
      return false;
    }
    try {
      channel.send(data);
      return true;
    } catch (error) {
      this.options.onError?.(asError(error));
      return false;
    }
  }

  sendControl(data: string): boolean {
    const channel = this.control;
    if (
      this.closed ||
      !channel ||
      channel.readyState !== "open" ||
      new TextEncoder().encode(data).byteLength > 16384 ||
      channel.bufferedAmount + new TextEncoder().encode(data).byteLength > 65536
    )
      return false;
    try {
      channel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private attachControl(channel: RTCDataChannel): void {
    if (
      this.closed ||
      this.control ||
      !channel.ordered ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      return;
    }
    this.control = channel;
    channel.onopen = () => {
      if (!this.closed) this.options.onControlOpen?.();
    };
    channel.onclose = () => {
      if (!this.closed) this.options.onControlClose?.();
    };
    channel.onerror = () => {
      if (!this.closed) this.options.onControlClose?.();
    };
    channel.onmessage = (event) => {
      if (
        !this.closed &&
        typeof event.data === "string" &&
        new TextEncoder().encode(event.data).byteLength <= 16384
      ) {
        this.options.onControl?.(event.data);
      }
    };
    if (channel.readyState === "open") this.options.onControlOpen?.();
  }

  sendAsset(data: ArrayBuffer): boolean {
    const channel = this.asset;
    if (
      this.closed ||
      !channel ||
      channel.readyState !== "open" ||
      !(data instanceof ArrayBuffer) ||
      data.byteLength === 0 ||
      data.byteLength > 32768 ||
      channel.bufferedAmount + data.byteLength > 65536
    )
      return false;
    try {
      channel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private attachAsset(channel: RTCDataChannel): void {
    if (
      this.closed ||
      this.asset ||
      !channel.ordered ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      return;
    }
    this.asset = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (!this.closed) this.options.onAssetOpen?.();
    };
    channel.onmessage = (event) => {
      if (
        !this.closed &&
        event.data instanceof ArrayBuffer &&
        event.data.byteLength > 0 &&
        event.data.byteLength <= 32768
      )
        this.options.onAsset?.(event.data);
    };
    if (channel.readyState === "open") this.options.onAssetOpen?.();
  }

  async getStats(): Promise<RTCStatsReport> {
    this.assertOpen();
    const stats = await this.wait(this.pc.getStats());
    this.assertOpen();
    return stats;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.audioRevision;
    for (const cancel of this.pending) cancel(new Error("Peer connection is closed"));
    this.pending.clear();
    this.stopOwnedTracks();
    this.localTrack = null;
    this.desiredTrack = null;
    for (const track of this.remoteTracks) track.stop();
    this.remoteTracks.clear();
    this.pc.ontrack = null;
    this.pc.ondatachannel = null;
    this.pc.onconnectionstatechange = null;
    if (this.control) {
      this.control.onopen =
        this.control.onclose =
        this.control.onerror =
        this.control.onmessage =
          null;
      this.control.close();
      this.control = null;
    }
    if (this.motion) {
      this.motion.onmessage = null;
      this.motion.onerror = null;
      this.motion.close();
      this.motion = null;
    }
    if (this.asset) {
      this.asset.onopen = this.asset.onmessage = null;
      this.asset.close();
      this.asset = null;
    }
    // Stopping tracks is immediate; detachment is best-effort before closing the PC.
    void this.audio?.sender.replaceTrack(null).catch(() => {});
    this.pc.close();
    this.options.onState?.("closed");
  }

  private initializeAudio(audio: RTCRtpTransceiver): void {
    this.audio = audio;
    audio.direction = "sendrecv";
    this.preferOpus(audio);
    if (this.desiredTrack) {
      void this.setAudioTrack(this.desiredTrack).catch((error: unknown) => {
        if (!this.closed && !(error instanceof SupersededAudioChoice)) {
          this.options.onError?.(asError(error));
        }
      });
    }
  }

  private preferOpus(audio: RTCRtpTransceiver): void {
    if (
      typeof RTCRtpReceiver === "undefined" ||
      typeof RTCRtpReceiver.getCapabilities !== "function" ||
      typeof audio.setCodecPreferences !== "function"
    ) {
      return;
    }
    const codecs = RTCRtpReceiver.getCapabilities("audio")?.codecs;
    if (!codecs?.some((codec) => codec.mimeType.toLowerCase() === "audio/opus")) return;
    const preferred = [...codecs].sort(
      (a, b) =>
        Number(b.mimeType.toLowerCase() === "audio/opus") -
        Number(a.mimeType.toLowerCase() === "audio/opus"),
    );
    // Retain every supported codec, including redundancy/FEC; do not alter bitrates.
    try {
      audio.setCodecPreferences(preferred);
    } catch {
      // Older engines can expose the API without accepting the reported capabilities.
      // Their native codec defaults remain usable.
    }
  }

  private attachMotion(channel: RTCDataChannel): void {
    if (
      this.closed ||
      this.motion ||
      channel.label !== MOTION_LABEL ||
      channel.ordered ||
      channel.maxRetransmits !== 0 ||
      channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      return;
    }
    this.motion = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      if (
        !this.closed &&
        this.motion === channel &&
        event.data instanceof ArrayBuffer &&
        event.data.byteLength > 0 &&
        event.data.byteLength <= MAX_MOTION_BYTES
      ) {
        this.options.onMotion?.(event.data);
      }
    };
    channel.onerror = () => {
      if (!this.closed) this.options.onError?.(new Error("Motion data channel failed"));
    };
  }

  private localSignal(type: SignalEnvelope["type"]): string {
    this.assertOpen();
    const description = this.pc.localDescription;
    if (!description || description.type !== type || !this.roomId) {
      throw new Error("Local session description is unavailable");
    }
    const serialized = JSON.stringify({
      version: 1,
      roomId: this.roomId,
      type,
      sdp: description.sdp,
    });
    readSignal(serialized, type);
    return serialized;
  }

  private gatherIce(): Promise<void> {
    this.assertOpen();
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.pc.removeEventListener("icegatheringstatechange", onChange);
        this.pending.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = (error: Error) => finish(error);
      const onChange = () => {
        if (this.pc.iceGatheringState === "complete") finish();
      };
      const timer = setTimeout(() => finish(new Error("ICE gathering timed out")), ICE_TIMEOUT_MS);
      this.pending.add(cancel);
      this.pc.addEventListener("icegatheringstatechange", onChange);
      onChange();
    });
  }

  private wait<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => {
        this.pending.delete(cancel);
        reject(error);
      };
      if (this.closed) {
        void operation.catch(() => {});
        reject(new Error("Peer connection is closed"));
        return;
      }
      this.pending.add(cancel);
      operation.then(
        (value) => {
          this.pending.delete(cancel);
          if (this.closed) reject(new Error("Peer connection is closed"));
          else resolve(value);
        },
        (error: unknown) => cancel(asError(error)),
      );
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Peer connection is closed");
  }

  private assertPhase(phase: typeof this.phase): void {
    this.assertOpen();
    if (this.phase !== phase) throw new Error("Unexpected or duplicate negotiation operation");
  }

  private stopOwnedTracks(): void {
    for (const track of this.ownedTracks) track.stop();
    this.ownedTracks.clear();
  }

  private releaseUnusedTracks(): void {
    for (const track of this.ownedTracks) {
      if (track !== this.localTrack && track !== this.desiredTrack) {
        track.stop();
        this.ownedTracks.delete(track);
      }
    }
  }

  private fail(value: unknown): Error {
    const error = asError(value);
    if (!this.closed) {
      this.close();
      this.options.onError?.(error);
    }
    return error;
  }
}

import type { VRM } from "@pixiv/three-vrm";
import {
  AvatarMotionBuffer,
  captureAvatarMotion,
  decodeAvatarMotion,
  encodeAvatarMotion,
} from "./avatar-motion";
import {
  type CallConsent,
  createCallInvitation,
  INVITATION_TTL_MS,
  readCallConsent,
  readCallInvitation,
} from "./call-invitation";
import { PeerCallConnection } from "./peer-connection";
import { RoomAudio } from "./room-audio";

export interface CallMetrics {
  receivedKbps?: number;
  jitterMs?: number;
  concealedPercent?: number;
  codec?: string;
  route?: "direct" | "relay";
}

/** Single-use native call endpoint. Remote data has no access to the resident or tools. */
export class CallPeer {
  readonly connection: PeerCallConnection;
  readonly audio: RoomAudio;
  readonly motion = new AvatarMotionBuffer(100);
  state: RTCPeerConnectionState = "new";
  remote: CallConsent | null = null;
  allowRemoteAi = false;
  aiActive = false;
  outputEnabled = true;
  metrics: CallMetrics = {};
  error = "";
  closed = false;
  private expiresAt = 0;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly timer: ReturnType<typeof setInterval>;
  private remoteAudio: MediaStream | null = null;
  private readonly remoteListeners = new Set<(stream: MediaStream | null) => void>();
  private readonly inputListeners = new Set<(stream: MediaStream | null) => void>();
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly assetListeners = new Set<(data: ArrayBuffer) => void>();
  private readonly assetOpenListeners = new Set<() => void>();
  private assetReady = false;
  private readonly closeListeners = new Set<() => void>();
  private readonly permissionListeners = new Set<() => void>();
  private sequence = 0;
  private revision = 0;
  private operation = 0;
  private micOperation = 0;
  private outputOperation = 0;
  private statsPending = false;
  private lastBytes = new Map<string, { bytes: number; time: number }>();
  private tick = 0;
  private motionBudget = { tokens: 60, time: performance.now() };
  private controlBudget = { tokens: 40, time: performance.now() };
  private protocolReady = false;
  private protocolDeadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly name: string,
    private readonly getAvatar: () => VRM | null,
    private readonly changed: () => void,
    options: { iceServers?: RTCIceServer[]; monitorAgent?: boolean } = {},
  ) {
    this.audio = new RoomAudio(options.monitorAgent ?? true);
    this.connection = new PeerCallConnection({
      productCall: true,
      iceServers: options.iceServers,
      onState: (state) => {
        if (this.closed) return;
        this.state = state;
        if (state === "connected") {
          clearTimeout(this.deadline);
          if (!this.remote)
            this.protocolDeadline = setTimeout(
              () => this.fail("相手の通話方式を確認できませんでした。"),
              10_000,
            );
        }
        if (state === "failed" || state === "disconnected" || state === "closed") {
          this.fail("接続が切れました。新しい招待でかけ直してください。");
        }
        changed();
      },
      onRemoteStream: (stream, kind) => {
        if (this.closed) return;
        // Product negotiation rejects unclassified/legacy mixed audio. Never
        // route unknown sources into the avatar's AI-only analyser.
        if (kind !== "agent" && kind !== "human") return;
        try {
          this.audio.setRemote(kind, stream);
          if (kind === "agent") this.remoteAudio = stream;
          this.notifyRemote();
        } catch {
          this.fail("受信音声を準備できませんでした。");
        }
      },
      onMotion: (data) => {
        if (this.closed) return;
        if (!this.consume(this.motionBudget, 30, 60)) return;
        const frame = decodeAvatarMotion(data);
        if (frame) this.motion.push(frame, performance.now());
      },
      onControlOpen: () => {
        this.protocolReady = true;
        this.publishConsent();
      },
      onAsset: (data) => {
        for (const listener of this.assetListeners) listener(data);
      },
      onAssetOpen: () => {
        this.assetReady = true;
        for (const listener of this.assetOpenListeners) listener();
      },
      onControlClose: () => this.fail("相手の参加状態を確認できなくなりました。"),
      onControl: (text) => {
        if (!this.consume(this.controlBudget, 20, 40)) {
          this.fail("参加状態の更新が多すぎます。");
          return;
        }
        if (this.closed) return;
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (message && typeof message === "object" && "protocol" in message) {
          if (this.remote) for (const listener of this.messageListeners) listener(message);
          return;
        }
        const consent = readCallConsent(text);
        if (this.closed || !consent || (this.remote && consent.revision <= this.remote.revision))
          return;
        const permissionChanged = this.remote?.allowRemoteAi !== consent.allowRemoteAi;
        this.remote = consent;
        if (this.protocolDeadline) clearTimeout(this.protocolDeadline);
        if (permissionChanged && !consent.allowRemoteAi) {
          // Stop provider input synchronously before notifying a controller to tear it down.
          for (const listener of this.remoteListeners) listener(null);
          for (const listener of this.inputListeners) listener(null);
          this.audio.stopAgent();
          this.aiActive = false;
          for (const listener of this.permissionListeners) listener();
        }
        if (permissionChanged) this.notifyRemote();
        changed();
      },
      onError: (error) => this.fail(error.message),
    });
    this.deadline = setTimeout(() => this.fail("招待の期限が切れました。"), INVITATION_TTL_MS);
    this.timer = setInterval(() => {
      if (this.closed || this.state !== "connected") return;
      const vrm = this.getAvatar();
      if (vrm) {
        try {
          this.connection.sendMotion(
            encodeAvatarMotion(captureAvatarMotion(vrm, this.sequence++ >>> 0, performance.now())),
          );
        } catch {
          /* An avatar being replaced may temporarily have no valid pose. */
        }
      }
      if (++this.tick % 10 === 0) {
        this.publishConsent();
        void this.updateStats();
      }
    }, 100);
  }

  async prepare(): Promise<void> {
    const tracks = await this.audio.prepare();
    if (this.closed) {
      tracks.human.stop();
      tracks.agent.stop();
      throw new Error("通話は終了しました。");
    }
    await Promise.all([
      this.connection.setAudioTrack(tracks.human, "human"),
      this.connection.setAudioTrack(tracks.agent, "agent"),
    ]);
    await this.audio.setOutput(this.outputEnabled);
    this.notifyRemote();
  }

  async invite(): Promise<string> {
    await this.prepare();
    const signal = await this.connection.createOffer();
    this.expiresAt = Date.now() + INVITATION_TTL_MS;
    return createCallInvitation(signal, this.expiresAt);
  }

  async accept(code: string): Promise<string> {
    const invite = readCallInvitation(code);
    this.expiresAt = invite.expiresAt;
    await this.prepare();
    const answer = await this.connection.acceptOffer(invite.signal);
    if (Date.now() >= this.expiresAt) {
      this.close();
      throw new Error("招待の期限が切れました。");
    }
    return createCallInvitation(answer, this.expiresAt);
  }

  async complete(code: string): Promise<void> {
    const answer = readCallInvitation(code);
    if (answer.expiresAt !== this.expiresAt || Date.now() >= this.expiresAt)
      throw new Error("この通話への応答ではないか、期限が切れています。");
    await this.connection.acceptAnswer(answer.signal);
  }

  setRemoteAiAllowed(allowed: boolean): void {
    if (this.closed) return;
    this.allowRemoteAi = allowed;
    this.publishConsent();
    this.changed();
  }

  onPermissionRevoked(listener: () => void): () => void {
    this.permissionListeners.add(listener);
    return () => {
      this.permissionListeners.delete(listener);
    };
  }

  async startAgentOutput(stream: MediaStream): Promise<void> {
    if (this.closed || this.state !== "connected" || !this.remote?.allowRemoteAi)
      throw new Error("相手がAIへの音声共有を許可していません。");
    const operation = ++this.operation;
    await this.audio.setAgent(stream);
    if (this.closed || operation !== this.operation) {
      throw new Error("AI参加が取り消されました。");
    }
    if (!this.remote?.allowRemoteAi) {
      this.audio.stopAgent();
      throw new Error("AI参加が取り消されました。");
    }
    this.aiActive = true;
    this.publishConsent();
    this.changed();
  }

  async stopInput(): Promise<void> {
    ++this.operation;
    this.audio.stopAgent();
    this.aiActive = false;
    this.publishConsent();
    this.changed();
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    if (enabled && (this.closed || this.state !== "connected"))
      throw new Error("通話を接続してください。");
    const operation = ++this.micOperation;
    await this.audio.setMicrophone(enabled);
    if (this.closed || operation !== this.micOperation) return;
    this.publishConsent();
    this.changed();
  }

  async setOutput(enabled: boolean): Promise<void> {
    const operation = ++this.outputOperation;
    await this.audio.setOutput(enabled);
    if (this.closed || operation !== this.outputOperation) return;
    this.outputEnabled = enabled;
    this.changed();
  }

  /** Remote AI output only; provider input should use onInputAudio for the full mix. */
  onRemoteAudio(listener: (stream: MediaStream | null) => void): () => void {
    if (!this.closed) this.remoteListeners.add(listener);
    listener(this.closed || !this.remote?.allowRemoteAi ? null : this.remoteAudio);
    return () => {
      this.remoteListeners.delete(listener);
    };
  }

  onInputAudio(listener: (stream: MediaStream | null) => void): () => void {
    if (!this.closed) this.inputListeners.add(listener);
    listener(this.closed || !this.remote?.allowRemoteAi ? null : this.audio.getAgentInput());
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  sendMessage(message: unknown): boolean {
    if (this.closed || !this.remote) return false;
    try {
      return this.connection.sendControl(JSON.stringify(message));
    } catch {
      return false;
    }
  }

  onAsset(listener: (data: ArrayBuffer) => void): () => void {
    this.assetListeners.add(listener);
    return () => {
      this.assetListeners.delete(listener);
    };
  }

  onAssetReady(listener: () => void): () => void {
    this.assetOpenListeners.add(listener);
    if (this.assetReady && !this.closed) listener();
    return () => {
      this.assetOpenListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    if (this.closed) listener();
    else this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.operation;
    ++this.micOperation;
    ++this.outputOperation;
    clearTimeout(this.deadline);
    if (this.protocolDeadline) clearTimeout(this.protocolDeadline);
    clearInterval(this.timer);
    this.remote = null;
    this.remoteAudio = null;
    this.lastBytes.clear();
    this.audio.close();
    this.connection.close();
    this.motion.reset();
    for (const listener of this.remoteListeners) listener(null);
    for (const listener of this.inputListeners) listener(null);
    for (const listener of this.closeListeners) listener();
    this.remoteListeners.clear();
    this.inputListeners.clear();
    this.messageListeners.clear();
    this.assetListeners.clear();
    this.assetOpenListeners.clear();
    this.closeListeners.clear();
    this.permissionListeners.clear();
    this.aiActive = false;
    this.allowRemoteAi = false;
    this.state = "closed";
    this.changed();
  }

  private consume(budget: { tokens: number; time: number }, rate: number, burst: number): boolean {
    const now = performance.now();
    budget.tokens = Math.min(burst, budget.tokens + (Math.max(0, now - budget.time) * rate) / 1000);
    budget.time = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.error = message;
    this.close();
  }

  private notifyRemote(): void {
    for (const listener of this.remoteListeners)
      listener(this.remote?.allowRemoteAi ? this.remoteAudio : null);
    for (const listener of this.inputListeners)
      listener(this.remote?.allowRemoteAi ? this.audio.getAgentInput() : null);
  }

  private publishConsent(): void {
    if (this.closed || !this.protocolReady) return;
    const message: CallConsent = {
      version: 1,
      revision: ++this.revision,
      name: this.name,
      allowRemoteAi: this.allowRemoteAi,
      aiActive: this.aiActive,
      microphoneActive: this.audio.microphoneActive,
    };
    if (!this.connection.sendControl(JSON.stringify(message)))
      this.fail("参加状態を送信できませんでした。");
  }

  private async updateStats(): Promise<void> {
    if (this.closed || this.statsPending) return;
    this.statsPending = true;
    try {
      const stats = await this.connection.getStats();
      if (this.closed) return;
      const next: CallMetrics = {};
      const currentBytes = new Map<string, { bytes: number; time: number }>();
      let samples = 0;
      let concealed = 0;
      const codecs = new Set<string>();
      stats.forEach((entry) => {
        if (entry.type === "inbound-rtp" && entry.kind === "audio") {
          const current = { bytes: Number(entry.bytesReceived), time: Number(entry.timestamp) };
          const previous = this.lastBytes.get(entry.id);
          if (
            previous &&
            Number.isFinite(current.bytes) &&
            Number.isFinite(current.time) &&
            current.time > previous.time &&
            current.bytes >= previous.bytes
          )
            next.receivedKbps =
              (next.receivedKbps ?? 0) +
              ((current.bytes - previous.bytes) * 8) / (current.time - previous.time);
          if (Number.isFinite(current.bytes) && Number.isFinite(current.time))
            currentBytes.set(entry.id, current);
          // Show the worst track jitter and sample-weighted concealment across both sources.
          if (Number.isFinite(entry.jitter))
            next.jitterMs = Math.max(next.jitterMs ?? 0, entry.jitter * 1000);
          if (entry.totalSamplesReceived > 0 && Number.isFinite(entry.concealedSamples)) {
            samples += entry.totalSamplesReceived;
            concealed += entry.concealedSamples;
          }
          const codec = stats.get(entry.codecId)?.mimeType;
          if (typeof codec === "string") codecs.add(codec);
        }
        if (entry.type === "transport" && entry.selectedCandidatePairId) {
          const pair = stats.get(entry.selectedCandidatePairId);
          const local = pair && stats.get(pair.localCandidateId);
          const remote = pair && stats.get(pair.remoteCandidateId);
          if (local && remote)
            next.route =
              local.candidateType === "relay" || remote.candidateType === "relay"
                ? "relay"
                : "direct";
        }
      });
      this.lastBytes = currentBytes;
      if (samples > 0) next.concealedPercent = (concealed / samples) * 100;
      if (codecs.size > 0) next.codec = [...codecs].sort().join(" / ");
      this.metrics = next;
      this.changed();
    } catch {
      // An in-flight statistics read is invalidated by hang-up.
    } finally {
      this.statsPending = false;
    }
  }
}

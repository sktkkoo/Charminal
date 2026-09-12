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
  private lastBytes?: { bytes: number; time: number };
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
      onRemoteStream: (stream) => {
        if (this.closed) return;
        this.remoteAudio = stream;
        try {
          this.audio.setRemote(stream);
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
    const track = await this.audio.prepare();
    if (this.closed) {
      track.stop();
      throw new Error("通話は終了しました。");
    }
    await this.connection.setAudioTrack(track);
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
      stats.forEach((entry) => {
        if (entry.type === "inbound-rtp" && entry.kind === "audio") {
          const current = { bytes: Number(entry.bytesReceived), time: Number(entry.timestamp) };
          if (
            this.lastBytes &&
            current.time > this.lastBytes.time &&
            current.bytes >= this.lastBytes.bytes
          )
            next.receivedKbps =
              ((current.bytes - this.lastBytes.bytes) * 8) / (current.time - this.lastBytes.time);
          if (Number.isFinite(current.bytes) && Number.isFinite(current.time))
            this.lastBytes = current;
          if (typeof entry.jitter === "number") next.jitterMs = entry.jitter * 1000;
          if (entry.totalSamplesReceived > 0)
            next.concealedPercent = (entry.concealedSamples / entry.totalSamplesReceived) * 100;
          next.codec = stats.get(entry.codecId)?.mimeType;
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
      this.metrics = next;
      this.changed();
    } catch {
      // An in-flight statistics read is invalidated by hang-up.
    } finally {
      this.statsPending = false;
    }
  }
}

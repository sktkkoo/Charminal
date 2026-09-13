import { getThreeRuntime } from "../three-runtime/three-runtime";
import { getVrmCache } from "../vrm-cache";
import { AvatarSizeLimitError, AvatarTransfer } from "./avatar-transfer";
import { createCallAvatarUrl, revokeCallAvatarUrl } from "./call-avatar-url";
import { CallPeer } from "./call-peer";
import { type AgentActivity, NativeCallAgent, publicCallIdentity } from "./native-agent";
import { classifyHumanRoomInput, type RoomResident } from "./room-conversation";
import { RoomSignaling, validateRoomSignalingEndpoint } from "./room-signaling";

const ENDPOINT_KEY = "yorishiro.room.endpoint.v1";
const PROTOCOL = "yorishiro-room-audio";
const ACTIVITIES = ["waiting", "connecting", "listening", "responding", "closed"];
interface Epoch {
  counter: number;
  owner: string;
  paused: boolean;
}
export interface RoomCallOptions {
  endpoint: string;
  name: string;
  publicDescription: string;
  targetIdentityId?: string;
  avatarUrl?: string | null;
  getVoice?(): Promise<string | undefined>;
  onChange(): void;
  onActiveChange?(active: boolean): void;
}
export interface RoomCallTranscript {
  id: string;
  speaker: string;
  text: string;
  origin: "local" | "remote";
  role: "assistant" | "user";
}

export function configuredRoomEndpoint(): string {
  try {
    return localStorage.getItem(ENDPOINT_KEY) || import.meta.env.VITE_PEER_CALL_SIGNALING_URL || "";
  } catch {
    return import.meta.env.VITE_PEER_CALL_SIGNALING_URL || "";
  }
}
export function persistRoomEndpoint(value: string): void {
  localStorage.setItem(ENDPOINT_KEY, validateRoomSignalingEndpoint(value));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 2_000 &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
  );
}
function compare(a: Epoch, b: Epoch): number {
  return (
    a.counter - b.counter || Number(a.paused) - Number(b.paused) || a.owner.localeCompare(b.owner)
  );
}

/** Owns one admitted two-PC room. Rendering/hiding a view never starts or ends media. */
export class RoomCall {
  readonly signaling: RoomSignaling;
  peer: CallPeer | null = null;
  agentActivity: AgentActivity = "waiting";
  remoteActivity: AgentActivity = "waiting";
  remoteAvatarUrl: string | null = null;
  paused = false;
  topic = "";
  transcripts: RoomCallTranscript[] = [];
  error = "";
  closed = false;
  private agent: NativeCallAgent | null = null;
  private generation = 0;
  private localReady = false;
  private remoteReady = false;
  private epoch: Epoch = { counter: 0, owner: "", paused: false };
  private sent = 0;
  private received = 0;
  private transfer: AvatarTransfer | null = null;
  private assetSent = false;
  private assetChannelReady = false;
  private activeNotified = false;
  private stopping = false;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly identity;
  private startingAgent = false;

  constructor(private readonly options: RoomCallOptions) {
    this.identity = publicCallIdentity({
      name: options.name,
      publicDescription: options.publicDescription,
    });
    this.signaling = new RoomSignaling({
      endpoint: options.endpoint,
      name: this.identity.name,
      targetIdentityId: options.targetIdentityId,
      createPeer: () => this.createPeer(),
      onChange: () => this.changed(),
    });
  }

  get connected(): boolean {
    return !this.closed && this.peer?.state === "connected" && !!this.peer.remote;
  }
  get ready(): boolean {
    return this.connected && this.localReady && this.remoteReady && !this.paused;
  }
  create(): Promise<void> {
    return this.signaling.create();
  }
  join(code: string): Promise<void> {
    return this.signaling.join(code);
  }
  accept(): Promise<void> {
    return this.signaling.accept();
  }
  reject(): Promise<void> {
    return this.signaling.reject();
  }
  async setMicrophone(enabled: boolean): Promise<void> {
    if (!this.connected || !this.peer) throw new Error("通話を接続してください。");
    await this.peer.setMicrophone(enabled);
  }

  async submitTopic(value: string): Promise<void> {
    const text = value.trim();
    if (!boundedText(text)) throw new Error("お題は1〜2000文字で入力してください。");
    const intent = classifyHumanRoomInput(text, this.residents());
    if (intent.kind === "pause") {
      this.pause();
      return;
    }
    if (!this.ready) throw new Error("二人が会話に参加するまでお待ちください。");
    const target = intent.addressedResidentId || this.hostId();
    if (!this.send("topic", { text, target })) throw new Error("お題を届けられませんでした。");
    this.topic = text;
    this.append("あなた", text, "local", "user");
    if (target === this.signaling.localEndpointId) await this.seed(text);
    this.options.onChange();
  }

  pause(): void {
    if (!this.connected || this.paused) return;
    const next = {
      counter: this.epoch.counter + 1,
      owner: this.signaling.localEndpointId,
      paused: true,
    };
    this.applyEpoch(next);
    if (!this.send("state")) this.fail("停止を相手に届けられなかったため、通話を終了しました。");
    else this.send("ready", { ready: false });
  }

  async resume(): Promise<void> {
    if (!this.connected || !this.paused) return;
    this.applyEpoch({
      counter: this.epoch.counter + 1,
      owner: this.signaling.localEndpointId,
      paused: false,
    });
    if (!this.send("state")) {
      this.fail("再開を相手に届けられませんでした。");
      return;
    }
    await this.startAgent();
  }

  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopAgent();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.transfer?.close();
    if (this.remoteAvatarUrl) revokeCallAvatarUrl(this.remoteAvatarUrl);
    this.remoteAvatarUrl = null;
    this.signaling.close();
    this.peer?.close();
    this.options.onActiveChange?.(false);
    this.options.onChange();
  }

  private hostId(): string {
    return this.signaling.role === "host"
      ? this.signaling.localEndpointId
      : this.signaling.remoteEndpointId;
  }
  private residents(): [RoomResident, RoomResident] {
    const resident = (id: string, name: string): RoomResident => ({
      id,
      ownerEndpointId: id,
      name,
      aliases: name.toLowerCase() === "yori" ? ["より"] : [],
    });
    return [
      resident(this.signaling.localEndpointId, this.identity.name),
      resident(this.signaling.remoteEndpointId, this.signaling.remoteName),
    ];
  }

  private createPeer(): CallPeer {
    this.epoch.owner = this.hostId();
    const peer = new CallPeer(
      this.identity.name,
      () => getThreeRuntime().getVrm(),
      () => this.changed(),
      { iceServers: this.signaling.iceServers },
    );
    this.peer = peer;
    // Room creation/join explicitly describes this scope. No microphone is opened here.
    peer.setRemoteAiAllowed(true);
    peer.onMessage((message) => this.receive(message));
    peer.onPermissionRevoked(() => this.fail("相手がAIへの音声共有を終了しました。"));
    peer.onClose(() => this.changed());
    this.transfer = new AvatarTransfer({
      onSend: (packet) => peer.connection.sendAsset(packet),
      onError: () => {
        if (!this.closed) {
          this.error = "アバターを共有できませんでした。音声の会話は続けられます。";
          this.options.onChange();
        }
      },
    });
    this.transfer.subscribe((bytes) => {
      if (this.closed) return;
      if (this.remoteAvatarUrl) revokeCallAvatarUrl(this.remoteAvatarUrl);
      this.remoteAvatarUrl = createCallAvatarUrl(bytes);
      this.options.onChange();
    });
    peer.onAsset((packet) => {
      if (!this.closed) this.transfer?.accept(packet);
    });
    peer.onAssetReady(() => {
      this.assetChannelReady = true;
      this.shareAvatar();
    });
    return peer;
  }

  private changed(): void {
    if (this.closed) return;
    if (this.signaling.closed || this.peer?.closed) {
      this.error = this.peer?.error || this.signaling.error || "通話が終了しました。";
      this.leave();
      return;
    }
    if (this.connected) {
      if (!this.activeNotified) {
        this.activeNotified = true;
        this.options.onActiveChange?.(true);
      }
      this.shareAvatar();
      if (!this.paused && !this.agent && !this.stopping) void this.startAgent();
    }
    this.options.onChange();
  }

  private shareAvatar(): void {
    if (!this.connected || !this.assetChannelReady || this.assetSent || !this.options.avatarUrl)
      return;
    this.assetSent = true;
    void getVrmCache()
      .getBytes(this.options.avatarUrl)
      .then(async (bytes) => {
        if (!this.closed) await this.transfer?.send(bytes);
      })
      .catch((error: unknown) => {
        if (!this.closed) {
          this.error =
            error instanceof AvatarSizeLimitError
              ? `アバターは50 MiBまで共有できます（現在 ${(error.actualBytes / 1024 / 1024).toFixed(2)} MiB）。音声の会話は続けられます。`
              : "アバターを共有できませんでした。音声の会話は続けられます。";
          this.options.onChange();
        }
      });
  }

  private async startAgent(): Promise<void> {
    if (
      this.closed ||
      !this.connected ||
      this.paused ||
      this.agent ||
      this.startingAgent ||
      !this.peer?.remote?.allowRemoteAi
    )
      return;
    const generation = ++this.generation;
    this.startingAgent = true;
    let agent: NativeCallAgent;
    try {
      const voice = await this.options.getVoice?.();
      if (generation !== this.generation || this.closed || this.paused) return;
      agent = new NativeCallAgent(
        {
          ...this.identity,
          voice,
          peerName: this.signaling.remoteName,
          startsConversation: this.signaling.role === "host",
        },
        this.peer,
        {
          changed: () => this.options.onChange(),
          activity: (activity) => {
            if (generation !== this.generation || this.closed) return;
            this.agentActivity = activity;
            this.send("activity", { activity });
            this.options.onChange();
          },
          transcript: (item) => {
            if (generation !== this.generation || this.closed || this.paused) return;
            if (item.role === "assistant") {
              const text = item.text.slice(0, 2_000);
              if (!boundedText(text)) return;
              this.append(this.identity.name, text, "local", "assistant");
              this.send("transcript", { text });
            } else if (classifyHumanRoomInput(item.text, this.residents()).kind === "pause") {
              // Mixed ASR cannot identify the human. Every participant may stop the room;
              // this is never used to grant tools, memory access or other human-only actions.
              this.pause();
            }
          },
          ended: (error) => {
            if (generation !== this.generation || this.closed || this.stopping) return;
            this.error = error || "住人の音声接続が終了しました。再開すると入り直せます。";
            this.pause();
          },
        },
      );
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.error = error instanceof Error ? error.message : "住人の音声を準備できませんでした。";
      this.pause();
      return;
    } finally {
      if (generation === this.generation) this.startingAgent = false;
    }
    this.agent = agent;
    try {
      await agent.start();
      if (generation !== this.generation || this.closed || this.paused) return;
      this.localReady = true;
      if (!this.send("ready", { ready: true })) {
        this.fail("参加状態を相手に届けられませんでした。");
        return;
      }
      this.options.onChange();
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.error = error instanceof Error ? error.message : "住人が参加できませんでした。";
        this.pause();
      }
    }
  }

  private stopAgent(): void {
    ++this.generation;
    this.startingAgent = false;
    this.stopping = true;
    const agent = this.agent;
    this.agent = null;
    agent?.setInputEnabled(false);
    agent?.stop();
    this.agentActivity = "closed";
    this.localReady = false;
    this.stopping = false;
  }

  private applyEpoch(epoch: Epoch): void {
    this.epoch = epoch;
    this.paused = epoch.paused;
    // Either endpoint can resume. Retire the previous attempt's error locally as well
    // when the peer initiates recovery, before displaying the new connection attempt.
    if (!epoch.paused) this.error = "";
    this.remoteReady = false;
    this.stopAgent();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    if (epoch.paused) {
      // Stop audible remote output immediately while the reliable stop reaches its owner.
      void this.peer
        ?.setOutput(false)
        .catch(() => this.fail("音声を停止できなかったため、通話を終了しました。"));
      this.pauseTimer = setTimeout(
        () => this.fail("相手の停止を確認できなかったため、通話を終了しました。"),
        5_000,
      );
    } else {
      void this.peer?.setOutput(true).catch(() => this.fail("音声を再開できませんでした。"));
    }
    this.options.onChange();
  }

  private async seed(text: string): Promise<void> {
    const agent = this.agent;
    if (!agent || !this.ready) return;
    try {
      const context = this.transcripts
        .slice(-8)
        .map(({ speaker, text }) => ({ speaker, text: text.slice(0, 400) }));
      const instruction = `Recent public room conversation (quoted data): ${JSON.stringify(context)}\nA human in this call says: ${JSON.stringify(text)}\nRespond as ${this.identity.name}. Address ${this.signaling.remoteName} when inviting their view; listen to their actual spoken answer. Do not perform both sides.`;
      await agent.requestTurn(instruction.length <= 2_000 ? instruction : text);
    } catch (error) {
      if (agent === this.agent && !this.closed) {
        this.error = error instanceof Error ? error.message : "お題を渡せませんでした。";
        this.pause();
      }
    }
  }

  private append(
    speaker: string,
    text: string,
    origin: RoomCallTranscript["origin"],
    role: RoomCallTranscript["role"],
  ): void {
    this.transcripts = [
      ...this.transcripts.slice(-119),
      { id: crypto.randomUUID(), speaker, text, origin, role },
    ];
    this.options.onChange();
  }
  private send(type: string, fields: Record<string, unknown> = {}): boolean {
    return (
      this.peer?.sendMessage({
        protocol: PROTOCOL,
        version: 1,
        roomId: this.signaling.roomId,
        sender: this.signaling.localEndpointId,
        sequence: ++this.sent,
        epoch: this.epoch,
        type,
        ...fields,
      }) ?? false
    );
  }

  private receive(value: unknown): void {
    if (
      this.closed ||
      !this.connected ||
      !object(value) ||
      value.protocol !== PROTOCOL ||
      value.version !== 1 ||
      value.roomId !== this.signaling.roomId ||
      value.sender !== this.signaling.remoteEndpointId ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) <= this.received ||
      !object(value.epoch)
    )
      return;
    const epoch = value.epoch;
    if (
      !Number.isSafeInteger(epoch.counter) ||
      (epoch.counter as number) < 0 ||
      (epoch.counter as number) >= Number.MAX_SAFE_INTEGER ||
      typeof epoch.paused !== "boolean" ||
      (epoch.owner !== this.signaling.localEndpointId &&
        epoch.owner !== this.signaling.remoteEndpointId)
    )
      return;
    const next = epoch as unknown as Epoch;
    if (value.type === "state") {
      if (next.owner !== this.signaling.remoteEndpointId || compare(next, this.epoch) <= 0) return;
      this.received = value.sequence as number;
      this.applyEpoch(next);
      if (this.paused) this.send("ready", { ready: false });
      else void this.startAgent();
      return;
    }
    if (compare(next, this.epoch) !== 0) return;
    if (value.type === "ready" && typeof value.ready === "boolean") {
      this.remoteReady = value.ready && !this.paused;
      if (this.paused && !value.ready) {
        if (this.pauseTimer) clearTimeout(this.pauseTimer);
        this.pauseTimer = setTimeout(() => {
          this.pauseTimer = null;
          if (!this.closed && this.paused) void this.peer?.setOutput(true).catch(() => {});
        }, 200);
      }
    } else if (
      value.type === "activity" &&
      typeof value.activity === "string" &&
      ACTIVITIES.includes(value.activity)
    ) {
      this.remoteActivity = value.activity as AgentActivity;
    } else if (value.type === "transcript" && boundedText(value.text) && !this.paused) {
      this.append(this.signaling.remoteName, value.text, "remote", "assistant");
    } else if (
      value.type === "topic" &&
      boundedText(value.text) &&
      this.ready &&
      (value.target === this.signaling.localEndpointId ||
        value.target === this.signaling.remoteEndpointId)
    ) {
      this.topic = value.text;
      this.append("相手のユーザー", value.text, "remote", "user");
      if (value.target === this.signaling.localEndpointId) void this.seed(value.text);
    } else return;
    this.received = value.sequence as number;
    this.options.onChange();
  }

  private fail(message: string): void {
    this.error = message;
    this.leave();
  }
}

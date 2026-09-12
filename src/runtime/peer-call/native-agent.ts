import { Channel, invoke } from "@tauri-apps/api/core";

/** A borrowed call stream; implementations retain ownership of their source tracks. */
export interface AgentEndpoint {
  startAgentOutput(stream: MediaStream): Promise<void>;
  stopInput(): Promise<void>;
  /** Optional consented mix of the remote participants and local human; never agent output. */
  onInputAudio?(listener: (stream: MediaStream | null) => void): () => void;
  onRemoteAudio(listener: (stream: MediaStream | null) => void): () => void;
  onClose(listener: () => void): () => void;
}

/** Public character metadata only. Never pass persona instructions, memory, or a work thread. */
export interface CallResidentIdentity {
  readonly name: string;
  readonly publicDescription: string;
  readonly peerName?: string;
  readonly startsConversation?: boolean;
  /** Optional configured resident voice. Omitted voices use stable host/guest defaults. */
  readonly voice?: string;
}

// Installed Codex 0.154.0 ThreadRealtimeStartParams.RealtimeVoice schema.
const CALL_VOICES = new Set([
  "alloy",
  "arbor",
  "ash",
  "ballad",
  "breeze",
  "cedar",
  "coral",
  "cove",
  "echo",
  "ember",
  "juniper",
  "maple",
  "marin",
  "sage",
  "shimmer",
  "sol",
  "spruce",
  "vale",
  "verse",
]);

/**
 * Verified against the installed Codex 0.154.0 experimental app-server schema.
 * V3 uses Frameless Bidi: an oai-events channel does not imply public Realtime controls.
 * Natural audio conversations work; strict turn guarantees require a supported contract.
 */
export const NATIVE_CALL_AGENT_CAPABILITIES = Object.freeze({
  managedTurns: false,
  utteranceCancellation: false,
  playbackCompletion: false,
  reason:
    "現在のCodex音声接続は、発話順の指定・発話の中断・再生完了通知に対応していないため、AI同士の進行つき通話を開始できません。",
} as const);

export type AgentActivity = "waiting" | "connecting" | "listening" | "responding" | "closed";

export interface AgentTranscript {
  readonly id: string;
  readonly agentId: string;
  readonly label: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface NativeAgentCallbacks {
  changed(): void;
  transcript(value: AgentTranscript): void;
  ended(error?: string): void;
  activity?(value: AgentActivity): void;
}

export type NativeAgentEvent =
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "activity"; activity: "listening" | "responding" }
  | { type: "error"; message: string }
  | { type: "closed" };

/** Created only after explicit call-audio consent, independent of the resident thread. */
export class NativeCallAgent {
  readonly id = crypto.randomUUID();
  readonly identity: CallResidentIdentity;
  readonly label: string;
  readonly capabilities = NATIVE_CALL_AGENT_CAPABILITIES;
  status = "起動待ち";
  activity: AgentActivity = "waiting";
  private readonly pc: RTCPeerConnection;
  private readonly sender: RTCRtpSender;
  private readonly channel: RTCDataChannel;
  private readonly events: Channel<NativeAgentEvent>;
  private input: MediaStreamTrack | null = null;
  private inputSource: MediaStreamTrack | null = null;
  private inputStream: MediaStream | null = null;
  private inputEnabled = true;
  private readonly outputTracks = new Set<MediaStreamTrack>();
  private closed = false;
  private started = false;
  private unsubscribeAudio: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private inputQueue: Promise<void> = Promise.resolve();
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    identity: string | CallResidentIdentity,
    private readonly endpoint: AgentEndpoint,
    private readonly callbacks: NativeAgentCallbacks,
  ) {
    this.identity = publicCallIdentity(identity);
    this.label = this.identity.name;
    const resources = createAgentResources();
    this.pc = resources.pc;
    this.sender = resources.sender;
    this.channel = resources.channel;
    this.events = resources.events;
    this.events.onmessage = (event) => this.handleEvent(event);
    this.channel.onmessage = (event) => {
      if (this.closed || typeof event.data !== "string" || event.data.length > 65536) return;
      try {
        const value = JSON.parse(event.data);
        if (
          /handoff|delegat|function_call/i.test(`${value?.type ?? ""} ${value?.item?.type ?? ""}`)
        ) {
          this.fail(new Error("通話用AIでは作業やツールを実行できません。"));
        }
      } catch {
        // Provider events are data only; malformed messages are ignored.
      }
    };
    this.pc.ontrack = (event) => {
      if (this.closed || event.track.kind !== "audio") {
        event.track.stop();
        return;
      }
      this.outputTracks.add(event.track);
      try {
        void this.endpoint
          .startAgentOutput(new MediaStream([event.track]))
          .catch((error) => this.fail(error));
      } catch (error) {
        this.fail(error);
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      if (this.pc.connectionState === "connected") this.setStatus("会話に参加中");
      if (this.pc.connectionState === "disconnected") {
        this.setStatus("再接続を待っています");
        this.disconnectTimer = setTimeout(() => {
          this.fail(new Error("AIの音声接続が切れました。"));
        }, 10_000);
      } else if (["failed", "closed"].includes(this.pc.connectionState)) {
        this.fail(new Error("AIの音声接続が切れました。"));
      }
    };
    try {
      const unsubscribeClose = endpoint.onClose(() => this.stop());
      if (this.closed) unsubscribeClose();
      else this.unsubscribeClose = unsubscribeClose;
      if (!this.closed) {
        const subscribe = endpoint.onInputAudio ?? endpoint.onRemoteAudio;
        const unsubscribeAudio = subscribe.call(endpoint, (stream) => {
          if (this.closed) return;
          this.inputStream = stream;
          try {
            this.setInput(this.inputEnabled ? stream : null);
          } catch (error) {
            this.fail(error);
          }
        });
        if (this.closed) unsubscribeAudio();
        else this.unsubscribeAudio = unsubscribeAudio;
      }
    } catch (error) {
      this.closed = true;
      this.disposeResources();
      throw error;
    }
  }

  async start(options: { managedTurns?: boolean } = {}): Promise<void> {
    this.assertOpen();
    if (options.managedTurns && !this.capabilities.managedTurns) {
      const error = new Error(this.capabilities.reason);
      this.fail(error);
      throw error;
    }
    if (this.started) throw new Error("このエージェントは既に起動しています。");
    this.started = true;
    this.setActivity("connecting");
    this.setStatus("エージェントを起動中");
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.assertOpen();
      await this.waitFor(() => this.pc.iceGatheringState === "complete", 10_000);
      const sdp = this.pc.localDescription?.sdp;
      if (!sdp) throw new Error("AIの音声接続を準備できませんでした。");
      const answer = await invoke<{ sdp: string }>("peer_call_agent_start", {
        id: this.id,
        label: this.label,
        publicDescription: this.identity.publicDescription,
        peerName: this.identity.peerName,
        startsConversation: this.identity.startsConversation ?? false,
        voice: this.identity.voice,
        managedTurns: false,
        sdp,
        onEvent: this.events,
      });
      // Stop can precede a native start response. The host remembers cancelled IDs as well.
      if (this.closed) {
        void invoke("peer_call_agent_stop", { id: this.id }).catch(() => {});
        this.assertOpen();
      }
      await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      this.assertOpen();
      await this.waitFor(
        () => this.pc.connectionState === "connected" && this.channel.readyState === "open",
        25_000,
      );
      this.setStatus("会話に参加中");
      this.setActivity("listening");
    } catch (error) {
      if (!this.closed) this.fail(error);
      throw error;
    }
  }

  async greet(): Promise<void> {
    await this.sendText(
      "通話相手に短く挨拶して、話したいことを尋ねてください。相手の返事を待ってください。",
    );
  }

  async sendText(text: string): Promise<void> {
    this.assertOpen();
    await invoke("peer_call_agent_text", { id: this.id, text });
    this.assertOpen();
  }

  /**
   * Seeds a natural spoken response via supported appendText. It does not grant an
   * exclusive turn or acknowledge playback completion; remote speech can still interrupt.
   */
  async requestTurn(text: string): Promise<void> {
    await this.sendText(text);
  }

  /** Gates only borrowed call input. This is not provider utterance cancellation. */
  setInputEnabled(enabled: boolean): void {
    if (this.closed || this.inputEnabled === enabled) return;
    this.inputEnabled = enabled;
    this.setInput(enabled ? this.inputStream : null);
  }

  stop(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.disposeResources();
    void invoke("peer_call_agent_stop", { id: this.id }).catch(() => {});
    try {
      void this.endpoint.stopInput().catch(() => {});
    } catch {
      // A failed room callback cannot keep this agent's native session alive.
    }
    this.setStatus("停止");
    this.setActivity("closed");
    this.callbacks.ended(reason);
  }

  private disposeResources(): void {
    quietly(() => this.unsubscribeAudio?.());
    quietly(() => this.unsubscribeClose?.());
    this.unsubscribeAudio = null;
    this.unsubscribeClose = null;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    quietly(() => this.input?.stop());
    this.input = null;
    this.inputSource = null;
    this.inputStream = null;
    for (const track of this.outputTracks) quietly(() => track.stop());
    this.outputTracks.clear();
    this.events.onmessage = () => {};
    quietly(() => this.channel.close());
    quietly(() => this.pc.close());
  }

  private setInput(stream: MediaStream | null): void {
    if (this.closed) return;
    const source = stream?.getAudioTracks().find((track) => track.readyState === "live") ?? null;
    if (source === this.inputSource && (source === null || this.input?.readyState === "live"))
      return;
    const track = source?.clone() ?? null;
    this.inputSource = source;
    this.input?.stop();
    this.input = track;
    this.inputQueue = this.inputQueue
      .then(async () => {
        if (this.closed || this.input !== track) {
          track?.stop();
          return;
        }
        await this.sender.replaceTrack(track);
      })
      .catch((error) => this.fail(error));
  }

  private handleEvent(event: NativeAgentEvent): void {
    if (this.closed) return;
    if (event.type === "transcript") {
      this.callbacks.transcript({
        id: crypto.randomUUID(),
        agentId: this.id,
        label: this.label,
        role: event.role,
        text: event.text.slice(0, 4000),
      });
    } else if (event.type === "activity") this.setActivity(event.activity);
    else if (event.type === "error") this.fail(new Error(event.message));
    else if (event.type === "closed") this.stop();
  }

  private async waitFor(check: () => boolean, timeout: number): Promise<void> {
    const deadline = performance.now() + timeout;
    while (!check()) {
      this.assertOpen();
      if (performance.now() > deadline) throw new Error("AIの音声接続がタイムアウトしました。");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.assertOpen();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("エージェントの接続は終了しました。");
  }

  private setStatus(value: string): void {
    this.status = value;
    this.callbacks.changed();
  }

  private setActivity(value: AgentActivity): void {
    if (this.activity === value) return;
    this.activity = value;
    this.callbacks.activity?.(value);
    this.callbacks.changed();
  }

  private fail(error: unknown): void {
    this.stop(error instanceof Error ? error.message : String(error));
  }
}

/** Copy an allowlist rather than serializing the resident object across the host boundary. */
export function publicCallIdentity(value: string | CallResidentIdentity): CallResidentIdentity {
  const name = publicLine(typeof value === "string" ? value : value.name, 48);
  const publicDescription = publicLine(
    typeof value === "string" ? "" : value.publicDescription,
    240,
  );
  if (!name) throw new Error("通話に参加する住人の名前が必要です。");
  const peerName = typeof value === "string" ? "" : publicLine(value.peerName ?? "", 48);
  const startsConversation = typeof value !== "string" && value.startsConversation === true;
  const voice = typeof value === "string" ? undefined : value.voice?.trim();
  if (voice !== undefined && !CALL_VOICES.has(voice)) {
    throw new Error("通話に設定された住人の声は、このCodexでは利用できません。");
  }
  return Object.freeze({
    name,
    publicDescription,
    ...(peerName ? { peerName } : {}),
    startsConversation,
    voice: voice ?? (startsConversation ? "sol" : "juniper"),
  });
}

function createAgentResources() {
  const pc = new RTCPeerConnection();
  let channel: RTCDataChannel | undefined;
  try {
    const sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
    channel = pc.createDataChannel("oai-events");
    const events = new Channel<NativeAgentEvent>();
    return { pc, sender, channel, events };
  } catch (error) {
    quietly(() => channel?.close());
    quietly(() => pc.close());
    throw error;
  }
}

function quietly(cleanup: () => unknown): void {
  try {
    cleanup();
  } catch {
    /* Continue releasing the remaining owned resources. */
  }
}

function publicLine(value: string, limit: number): string {
  return Array.from(
    value
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, limit)
    .join("");
}

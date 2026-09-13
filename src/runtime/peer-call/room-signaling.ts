import type { CallPeer } from "./call-peer";
import { AudioProtocolVersionError } from "./peer-connection";

const PROTOCOL = "yorishiro-room-v1";
const MAX_MESSAGE_BYTES = 192 * 1024;
const MAX_SIGNAL_BYTES = 140 * 1024;
const INVITATION = /^yri1_[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16}$/;
const CLOSED_MESSAGES: Record<string, string> = {
  unavailable: "招待が見つからないか、すでに使用されています。新しい招待を受け取ってください。",
  busy: "このルームでは別の参加リクエストを確認しています。",
  duplicate_name: "同じ名前の住人がいます。通話で使う名前を変えてください。",
  expired: "ルームの有効期限が切れました。新しいルームを作ってください。",
  declined: "参加リクエストが見送られました。",
  rate_limited: "リクエストが多すぎます。少し待ってから新しいルームでお試しください。",
  capacity: "通話サーバーが混み合っています。少し待ってからお試しください。",
  participant_left: "相手がルームを退出しました。",
  timeout: "通話の接続が時間内に完了しませんでした。",
  protocol: "通話サーバーとの通信形式を確認できませんでした。",
  closed: "ルームは終了しました。",
};

function closedMessage(value: unknown): string {
  return typeof value === "string" && Object.keys(CLOSED_MESSAGES).includes(value)
    ? CLOSED_MESSAGES[value]
    : CLOSED_MESSAGES.protocol;
}

export type RoomSignalingState =
  | "idle"
  | "connecting"
  | "hosting"
  | "requesting"
  | "pending"
  | "negotiating"
  | "active"
  | "closed";

export interface PendingRoomGuest {
  requestId: string;
  endpointId: string;
  name: string;
}

export interface RoomSignalingOptions {
  endpoint: string;
  name: string;
  /** Called only after admission, with room/endpoint identities already populated. */
  createPeer: () => CallPeer;
  onChange: () => void;
  /** Test/embedding adapter. Production uses the browser WebSocket implementation. */
  createWebSocket?: (url: string, protocol: string) => WebSocket;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shape(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).sort().join() === [...fields].sort().join();
}

function name(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 64 &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}

function id(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function expiration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > Date.now() &&
    value <= Date.now() + 5 * 60_000 + 30_000
  );
}

/** Accept only the broker's bounded STUN and temporary coturn credentials. Never persist these. */
export function readRoomIceServers(
  value: unknown,
  expected?: { roomId: string; endpointId: string },
): RTCIceServer[] | null {
  if (!Array.isArray(value) || value.length > 2) return null;
  const servers: RTCIceServer[] = [];
  const kinds = new Set<string>();
  for (const entry of value) {
    if (
      !record(entry) ||
      !Array.isArray(entry.urls) ||
      entry.urls.length < 1 ||
      entry.urls.length > 4
    )
      return null;
    const urls: string[] = [];
    let kind = "";
    for (const url of entry.urls) {
      if (typeof url !== "string" || url.length > 256) return null;
      const match =
        /^(stuns?|turns?):((?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?)(?:\?transport=(udp|tcp))?$/.exec(
          url,
        );
      if (!match) return null;
      const nextKind = match[1].startsWith("stun") ? "stun" : "turn";
      if ((kind && kind !== nextKind) || (nextKind === "stun" && match[3]) || urls.includes(url))
        return null;
      kind = nextKind;
      try {
        const parsed = new URL(`https://${match[2]}`);
        if (
          !parsed.hostname ||
          parsed.port === "0" ||
          (!parsed.hostname.startsWith("[") &&
            parsed.hostname
              .replace(/\.$/, "")
              .split(".")
              .some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))
        )
          return null;
      } catch {
        return null;
      }
      urls.push(url);
    }
    if (kinds.has(kind)) return null;
    kinds.add(kind);
    if (kind === "stun") {
      if (!shape(entry, ["urls"])) return null;
      servers.push({ urls });
    } else {
      if (
        !shape(entry, ["urls", "username", "credential"]) ||
        typeof entry.username !== "string" ||
        entry.username.length > 128 ||
        typeof entry.credential !== "string" ||
        !/^[A-Za-z0-9+/]{27}=$/.test(entry.credential)
      )
        return null;
      const parts = entry.username.split(":");
      const expires = Number(parts[0]);
      const now = Math.floor(Date.now() / 1000);
      if (
        parts.length !== 3 ||
        !/^\d{10}$/.test(parts[0]) ||
        !id(parts[1]) ||
        !id(parts[2]) ||
        expires < now + 1800 ||
        expires > now + 3660 ||
        (expected && (parts[1] !== expected.roomId || parts[2] !== expected.endpointId))
      )
        return null;
      servers.push({ urls, username: entry.username, credential: entry.credential });
    }
  }
  return servers;
}

/** No credentials or invitation in the URL; insecure transport is local development only. */
export function validateRoomSignalingEndpoint(endpoint: string): string {
  if (!endpoint.trim()) throw new Error("通話サーバーが設定されていません。");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("通話サーバーのアドレスを確認してください。");
  }
  const host = url.hostname;
  const parts = host.split(".").map(Number);
  const privateV4 =
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  const local = host === "localhost" || host === "[::1]" || privateV4;
  if (
    endpoint.length > 2048 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/rooms" ||
    !(url.protocol === "wss:" || (url.protocol === "ws:" && local))
  )
    throw new Error("通話サーバーには認証情報を含まない wss://…/rooms を指定してください。");
  return url.href;
}

/** A single-use room. Signaling data stays off the clipboard and out of URLs/storage. */
export class RoomSignaling {
  state: RoomSignalingState = "idle";
  invitation = "";
  expiresAt = 0;
  pendingGuest: PendingRoomGuest | null = null;
  peer: CallPeer | null = null;
  error = "";
  roomId = "";
  localEndpointId = "";
  remoteEndpointId = "";
  remoteName = "";
  role: "host" | "guest" | null = null;
  private admittedIceServers: RTCIceServer[] = [];
  private ws: WebSocket | null = null;
  private phase: "none" | "offer" | "answer" | "ready" | "active" = "none";
  private decisionPending = false;
  private queue = Promise.resolve();
  private queued = 0;
  private messageBudget = { tokens: 16, at: Date.now() };
  private starting: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private readonly options: RoomSignalingOptions) {
    if (!name(options.name)) throw new Error("参加者名は1〜64文字で入力してください。");
  }

  get closed(): boolean {
    return this.state === "closed";
  }

  /** Available before createPeer; the caller receives an independent in-memory copy. */
  get iceServers(): RTCIceServer[] {
    return this.admittedIceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    }));
  }

  async create(): Promise<void> {
    this.assertUnused();
    this.role = "host";
    await this.start({ type: "create", name: this.options.name.trim() });
  }

  async join(invitation: string): Promise<void> {
    this.assertUnused();
    const code = invitation.trim();
    if (!INVITATION.test(code)) throw new Error("短いルーム招待コードを確認してください。");
    this.role = "guest";
    await this.start({ type: "join", name: this.options.name.trim(), invitation: code });
  }

  async accept(): Promise<void> {
    if (
      this.role !== "host" ||
      this.state !== "pending" ||
      !this.pendingGuest ||
      this.decisionPending
    )
      throw new Error("参加リクエストがありません。");
    this.decisionPending = true;
    this.state = "negotiating";
    this.send({ type: "accept", requestId: this.pendingGuest.requestId });
    this.changed();
  }

  async reject(): Promise<void> {
    if (
      this.role !== "host" ||
      this.state !== "pending" ||
      !this.pendingGuest ||
      this.decisionPending
    )
      throw new Error("参加リクエストがありません。");
    this.decisionPending = true;
    this.send({ type: "reject", requestId: this.pendingGuest.requestId });
  }

  close(): void {
    this.finish();
  }

  private assertUnused(): void {
    if (this.state !== "idle") throw new Error("新しいルームを作ってください。");
  }

  private start(message: object): Promise<void> {
    const endpoint = validateRoomSignalingEndpoint(this.options.endpoint);
    this.state = "connecting";
    this.changed();
    if (this.closed) return Promise.reject(new Error(CLOSED_MESSAGES.closed));
    return new Promise((resolve, reject) => {
      this.starting = {
        resolve,
        reject,
        timer: setTimeout(() => this.fail(CLOSED_MESSAGES.timeout), 15_000),
      };
      try {
        const ws = this.options.createWebSocket
          ? this.options.createWebSocket(endpoint, PROTOCOL)
          : new WebSocket(endpoint, PROTOCOL);
        this.ws = ws;
        ws.onopen = () => {
          if (this.closed) ws.close();
          else {
            try {
              this.send(message);
            } catch {
              this.fail("通話サーバーへ送信できませんでした。");
            }
          }
        };
        ws.onmessage = (event) => this.enqueue(event.data);
        ws.onerror = () => this.fail("通話サーバーに接続できませんでした。");
        ws.onclose = () => this.fail("通話サーバーとの接続が切れました。");
      } catch {
        this.fail("通話サーバーに接続できませんでした。");
      }
    });
  }

  private enqueue(data: unknown): void {
    if (this.closed) return;
    const now = Date.now();
    this.messageBudget.tokens = Math.min(
      16,
      this.messageBudget.tokens + Math.max(0, now - this.messageBudget.at) / 500,
    );
    this.messageBudget.at = now;
    if (
      typeof data !== "string" ||
      data.length > MAX_MESSAGE_BYTES ||
      new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES ||
      this.queued >= 8 ||
      this.messageBudget.tokens < 1
    ) {
      this.fail(CLOSED_MESSAGES.protocol);
      return;
    }
    this.messageBudget.tokens--;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.fail(CLOSED_MESSAGES.protocol);
      return;
    }
    // Revocation must not wait for ICE gathering or media preparation to finish.
    if (
      record(message) &&
      ((message.type === "closed" && shape(message, ["type", "reason"])) ||
        (message.type === "error" && shape(message, ["type", "code"])))
    ) {
      const code = message.type === "closed" ? message.reason : message.code;
      this.fail(closedMessage(code));
      return;
    }
    this.queued++;
    this.queue = this.queue
      .then(async () => {
        this.queued--;
        if (!this.closed) await this.receive(message);
      })
      .catch((error: unknown) =>
        this.fail(
          error instanceof AudioProtocolVersionError
            ? new AudioProtocolVersionError().message
            : "通話を準備できませんでした。新しいルームでお試しください。",
        ),
      );
  }

  private async receive(value: unknown): Promise<void> {
    if (!record(value)) throw new Error("Invalid room message");
    if (
      value.type === "created" &&
      shape(value, ["type", "invitation", "expiresAt", "roomId", "localEndpointId"]) &&
      this.role === "host" &&
      this.state === "connecting" &&
      typeof value.invitation === "string" &&
      INVITATION.test(value.invitation) &&
      expiration(value.expiresAt) &&
      id(value.roomId) &&
      id(value.localEndpointId)
    ) {
      this.invitation = value.invitation;
      this.expiresAt = value.expiresAt;
      this.roomId = value.roomId;
      this.localEndpointId = value.localEndpointId;
      this.state = "hosting";
      this.started();
      return;
    }
    if (
      value.type === "requested" &&
      shape(value, [
        "type",
        "hostName",
        "expiresAt",
        "roomId",
        "localEndpointId",
        "remoteEndpointId",
      ]) &&
      this.role === "guest" &&
      this.state === "connecting" &&
      name(value.hostName) &&
      expiration(value.expiresAt) &&
      id(value.roomId) &&
      id(value.localEndpointId) &&
      id(value.remoteEndpointId)
    ) {
      this.remoteName = value.hostName;
      this.expiresAt = value.expiresAt;
      this.roomId = value.roomId;
      this.localEndpointId = value.localEndpointId;
      this.remoteEndpointId = value.remoteEndpointId;
      this.state = "requesting";
      this.started();
      return;
    }
    if (
      value.type === "request" &&
      shape(value, ["type", "requestId", "name", "endpointId"]) &&
      this.role === "host" &&
      this.state === "hosting" &&
      name(value.name) &&
      typeof value.requestId === "string" &&
      REQUEST_ID.test(value.requestId) &&
      id(value.endpointId)
    ) {
      this.pendingGuest = {
        requestId: value.requestId,
        name: value.name,
        endpointId: value.endpointId,
      };
      this.state = "pending";
      this.changed();
      return;
    }
    if (
      value.type === "request_cancelled" &&
      shape(value, ["type", "requestId"]) &&
      this.role === "host" &&
      value.requestId === this.pendingGuest?.requestId &&
      !this.peer &&
      (this.state === "pending" || this.state === "negotiating")
    ) {
      // A guest may cancel while the host's admission click is in flight.
      this.pendingGuest = null;
      this.decisionPending = false;
      this.state = "hosting";
      this.changed();
      return;
    }
    if (
      value.type === "admitted" &&
      shape(value, [
        "type",
        "role",
        "name",
        "roomId",
        "localEndpointId",
        "remoteEndpointId",
        "iceServers",
      ]) &&
      value.role === this.role &&
      value.roomId === this.roomId &&
      value.localEndpointId === this.localEndpointId &&
      id(value.remoteEndpointId) &&
      name(value.name) &&
      ((this.role === "host" &&
        this.state === "negotiating" &&
        this.decisionPending &&
        value.remoteEndpointId === this.pendingGuest?.endpointId) ||
        (this.role === "guest" &&
          this.state === "requesting" &&
          value.remoteEndpointId === this.remoteEndpointId))
    ) {
      const iceServers = readRoomIceServers(value.iceServers, {
        roomId: this.roomId,
        endpointId: this.localEndpointId,
      });
      if (!iceServers) throw new Error("Invalid room ICE configuration");
      this.admittedIceServers = iceServers;
      this.remoteEndpointId = value.remoteEndpointId;
      this.remoteName = value.name;
      this.state = "negotiating";
      this.phase = "offer";
      this.invitation = "";
      this.pendingGuest = null;
      this.changed();
      if (this.closed) return;
      const peer = this.options.createPeer();
      if (this.closed) {
        peer.close();
        return;
      }
      this.peer = peer;
      peer.onClose(() => this.close());
      this.changed();
      if (this.closed) return;
      if (this.role === "host") {
        const offer = await peer.invite();
        if (this.closed) return;
        this.phase = "answer";
        this.signal("offer", offer);
      }
      return;
    }
    if (
      value.type === "signal" &&
      shape(value, ["type", "kind", "data"]) &&
      typeof value.data === "string" &&
      value.data.length > 0 &&
      value.data.length <= MAX_SIGNAL_BYTES &&
      new TextEncoder().encode(value.data).byteLength <= MAX_SIGNAL_BYTES &&
      this.state === "negotiating" &&
      this.peer
    ) {
      if (this.role === "guest" && this.phase === "offer" && value.kind === "offer") {
        this.phase = "answer";
        const answer = await this.peer.accept(value.data);
        if (this.closed) return;
        this.phase = "ready";
        this.signal("answer", answer);
        return;
      }
      if (this.role === "host" && this.phase === "answer" && value.kind === "answer") {
        this.phase = "ready";
        await this.peer.complete(value.data);
        if (!this.closed) this.send({ type: "ready" });
        return;
      }
    }
    if (
      value.type === "active" &&
      shape(value, ["type"]) &&
      this.state === "negotiating" &&
      this.phase === "ready"
    ) {
      this.phase = "active";
      this.state = "active";
      this.changed();
      return;
    }
    throw new Error("Unexpected room message");
  }

  private signal(kind: "offer" | "answer", data: string): void {
    if (!data || new TextEncoder().encode(data).byteLength > MAX_SIGNAL_BYTES)
      throw new Error("Invalid call signal");
    this.send({ type: "signal", kind, data });
  }

  private send(message: object): void {
    if (this.closed || !this.ws || this.ws.readyState !== 1) throw new Error("Room is closed");
    const data = JSON.stringify(message);
    if (
      new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES ||
      this.ws.bufferedAmount > MAX_MESSAGE_BYTES * 2
    )
      throw new Error("Room message limit exceeded");
    this.ws.send(data);
  }

  private started(): void {
    if (this.starting) {
      clearTimeout(this.starting.timer);
      this.starting.resolve();
      this.starting = null;
    }
    this.changed();
  }

  private changed(): void {
    this.options.onChange();
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.error = message;
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.state = "closed";
    this.invitation = "";
    this.pendingGuest = null;
    this.admittedIceServers = [];
    if (this.starting) {
      clearTimeout(this.starting.timer);
      this.starting.reject(new Error(this.error || CLOSED_MESSAGES.closed));
      this.starting = null;
    }
    this.peer?.close();
    try {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "leave" }));
      this.ws?.close();
    } catch {
      // Room ownership also expires on socket loss and the broker's deadline.
    }
    this.changed();
  }
}

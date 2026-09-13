import {
  CALL_IDENTITY_ID,
  CALL_ROOM_ID,
  type CallIdentity,
  CallSocketAuthentication,
  getCallIdentity,
  MANAGED_CALL_PROTOCOL,
  managedCallEndpoint,
  managedInvitationRoom,
} from "./call-identity";

export interface CallContact {
  identityId: string;
  name: string;
  lastAcceptedAt: number;
}
export interface IncomingCall {
  roomId: string;
  identityId: string;
  name: string;
  expiresAt: number;
  invitation: string;
}
export type CallPresenceState = "idle" | "connecting" | "online" | "offline" | "error";
interface Options {
  endpoint: string;
  name: string;
  onChange(): void;
  onIncoming?(incoming: IncomingCall): void;
  getIdentity?: typeof getCallIdentity;
  createWebSocket?: (url: string, protocol: string) => WebSocket;
}
const MAX_BYTES = 48 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function shape(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join() === keys.sort().join();
}
function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 64 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function contact(value: unknown): value is CallContact {
  return (
    record(value) &&
    shape(value, ["identityId", "name", "lastAcceptedAt"]) &&
    typeof value.identityId === "string" &&
    CALL_IDENTITY_ID.test(value.identityId) &&
    validName(value.name) &&
    typeof value.lastAcceptedAt === "number" &&
    Number.isSafeInteger(value.lastAcceptedAt) &&
    value.lastAcceptedAt > 0 &&
    value.lastAcceptedAt <= Date.now() + 30_000
  );
}

/** Main-owned metadata connection. It never creates media, agents or a RoomCall. */
export class CallPresence {
  state: CallPresenceState = "idle";
  error = "";
  contacts: CallContact[] = [];
  incoming: IncomingCall | null = null;
  private name: string;
  private busy = false;
  private endpoint: string;
  private identity: CallIdentity | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private generation = 0;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private incomingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: Options) {
    this.endpoint = managedCallEndpoint(options.endpoint);
    if (!validName(options.name)) throw new Error("通話での名前を確認してください。");
    this.name = options.name.trim();
  }
  async start(): Promise<void> {
    if (this.closed || this.state === "connecting" || this.state === "online") return;
    this.state = "connecting";
    this.error = "";
    const generation = ++this.generation;
    this.changed();
    try {
      this.identity = await (this.options.getIdentity ?? getCallIdentity)(this.endpoint);
      if (!this.closed && generation === this.generation) this.connect();
    } catch {
      if (!this.closed && generation === this.generation)
        this.fail("通話の識別情報を準備できませんでした。アプリを再起動してお試しください。");
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.generation;
    this.clearTimers();
    this.clearIncoming();
    this.disconnect();
    this.state = "idle";
    this.changed();
  }
  setPresence(name: string, busy: boolean): void {
    if (!validName(name) || typeof busy !== "boolean") throw new Error("Invalid call presence");
    this.name = name.trim();
    this.busy = busy;
    if (this.state === "online") this.send({ type: "presence", name: this.name, busy });
  }
  takeIncoming(roomId: string): string | null {
    const incoming = this.incoming;
    if (!incoming || incoming.roomId !== roomId) return null;
    const invitation =
      incoming.expiresAt > Date.now() && this.state === "online" ? incoming.invitation : null;
    this.clearIncoming();
    this.changed();
    return invitation;
  }
  decline(roomId: string): void {
    if (this.incoming?.roomId !== roomId) return;
    if (this.state === "online") this.send({ type: "decline", roomId });
    this.clearIncoming();
    this.changed();
  }
  removeContact(identityId: string): void {
    if (
      this.state !== "online" ||
      !CALL_IDENTITY_ID.test(identityId) ||
      !this.contacts.some((entry) => entry.identityId === identityId)
    )
      return;
    this.send({ type: "remove-contact", identityId });
  }
  private connect(): void {
    if (!this.identity || this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = ++this.generation;
    this.state = "connecting";
    this.changed();
    const url = new URL(this.endpoint);
    url.pathname = `/v2/users/${this.identity.identityId}`;
    const authentication = new CallSocketAuthentication(this.identity, url.href);
    try {
      const ws = this.options.createWebSocket
        ? this.options.createWebSocket(url.href, MANAGED_CALL_PROTOCOL)
        : new WebSocket(url.href, MANAGED_CALL_PROTOCOL);
      this.ws = ws;
      const current = () => !this.closed && generation === this.generation && this.ws === ws;
      let queue = Promise.resolve();
      let queued = 0;
      let budget = 20;
      let at = Date.now();
      this.authTimer = setTimeout(() => {
        if (current()) this.networkLost();
      }, 10_000);
      ws.onmessage = ({ data }) => {
        if (!current()) return;
        const now = Date.now();
        budget = Math.min(20, budget + Math.max(0, now - at) / 500);
        at = now;
        if (
          typeof data !== "string" ||
          data.length > MAX_BYTES ||
          new TextEncoder().encode(data).byteLength > MAX_BYTES ||
          queued >= 8 ||
          budget < 1
        ) {
          this.fail("通話サーバーとの通信形式を確認できませんでした。");
          return;
        }
        budget--;
        queued++;
        queue = queue
          .then(async () => {
            queued--;
            if (!current()) return;
            const message: unknown = JSON.parse(data);
            if (!record(message)) throw new Error("Invalid presence message");
            if (
              await authentication.receive(message, (reply) => {
                if (current()) this.send(reply);
              })
            ) {
              if (authentication.authenticated && current()) {
                if (this.authTimer) clearTimeout(this.authTimer);
                this.authTimer = null;
                this.state = "online";
                this.error = "";
                this.retries = 0;
                this.send({ type: "presence", name: this.name, busy: this.busy });
                this.changed();
              }
              return;
            }
            if (current()) this.receive(message);
          })
          .catch(() => {
            if (current()) this.fail("通話サーバーとの通信形式を確認できませんでした。");
          });
      };
      ws.onerror = ws.onclose = () => {
        if (current()) this.networkLost();
      };
    } catch {
      this.networkLost();
    }
  }
  private receive(message: Record<string, unknown>): void {
    if (
      message.type === "contacts" &&
      shape(message, ["type", "contacts"]) &&
      Array.isArray(message.contacts) &&
      message.contacts.length <= 100 &&
      message.contacts.every(contact)
    ) {
      const contacts = message.contacts as CallContact[];
      if (
        new Set(contacts.map((entry) => entry.identityId)).size !== contacts.length ||
        contacts.some((entry) => entry.identityId === this.identity?.identityId)
      )
        throw new Error("Invalid contacts");
      this.contacts = contacts.map((entry) => ({ ...entry }));
      this.changed();
      return;
    }
    if (
      message.type === "incoming" &&
      shape(message, ["type", "roomId", "invitation", "identityId", "name", "expiresAt"]) &&
      typeof message.roomId === "string" &&
      CALL_ROOM_ID.test(message.roomId) &&
      typeof message.invitation === "string" &&
      managedInvitationRoom(message.invitation) === message.roomId &&
      typeof message.identityId === "string" &&
      CALL_IDENTITY_ID.test(message.identityId) &&
      message.identityId !== this.identity?.identityId &&
      validName(message.name) &&
      typeof message.expiresAt === "number" &&
      Number.isSafeInteger(message.expiresAt) &&
      message.expiresAt > Date.now() &&
      message.expiresAt <= Date.now() + 50_000
    ) {
      if (this.incoming && this.incoming.roomId !== message.roomId)
        throw new Error("Incoming call already pending");
      if (this.busy) {
        this.send({ type: "decline", roomId: message.roomId });
        return;
      }
      this.clearIncoming();
      const incoming: IncomingCall = {
        roomId: message.roomId,
        identityId: message.identityId,
        name: message.name,
        invitation: message.invitation,
        expiresAt: message.expiresAt,
      };
      this.incoming = incoming;
      this.incomingTimer = setTimeout(() => {
        if (this.incoming?.roomId === incoming.roomId) {
          this.clearIncoming();
          this.changed();
        }
      }, incoming.expiresAt - Date.now());
      this.changed();
      this.options.onIncoming?.(incoming);
      return;
    }
    if (
      message.type === "incoming-ended" &&
      shape(message, ["type", "roomId", "reason"]) &&
      typeof message.roomId === "string" &&
      CALL_ROOM_ID.test(message.roomId) &&
      typeof message.reason === "string" &&
      message.reason.length <= 40
    ) {
      if (this.incoming?.roomId === message.roomId) {
        this.clearIncoming();
        this.changed();
      }
      return;
    }
    if (
      message.type === "error" &&
      shape(message, ["type", "code"]) &&
      typeof message.code === "string"
    ) {
      this.fail(
        message.code === "rate_limited"
          ? "通話へのリクエストが多すぎます。しばらくしてからお試しください。"
          : "通話の待受に接続できませんでした。",
      );
      return;
    }
    throw new Error("Invalid presence message");
  }
  private send(message: object): void {
    if (!this.ws || this.ws.readyState !== 1 || this.ws.bufferedAmount > MAX_BYTES * 2) {
      this.networkLost();
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      this.networkLost();
    }
  }
  private networkLost(): void {
    if (this.closed) return;
    ++this.generation;
    this.clearTimers();
    this.clearIncoming();
    this.disconnect();
    this.state = "offline";
    this.error = "通話の待受に接続できません。接続をやり直しています。";
    if (this.retries < 6)
      this.retryTimer = setTimeout(
        () => this.connect(),
        Math.min(30_000, 1000 * 2 ** this.retries++),
      );
    else {
      this.state = "error";
      this.error = "通話の待受に接続できませんでした。アプリを再起動してお試しください。";
    }
    this.changed();
  }
  private fail(message: string): void {
    ++this.generation;
    this.clearTimers();
    this.clearIncoming();
    this.disconnect();
    this.state = "error";
    this.error = message;
    this.changed();
  }
  private disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
  }
  private clearIncoming(): void {
    if (this.incomingTimer) clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
    this.incoming = null;
  }
  private clearTimers(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.authTimer = this.retryTimer = null;
  }
  private changed(): void {
    this.options.onChange();
  }
}

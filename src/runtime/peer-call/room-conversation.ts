/** Optional strict-turn adapter. Natural-audio providers must not fake playback completion. */
export const MAX_ROOM_TEXT_LENGTH = 2_000;
export const MAX_ROOM_EVENT_BYTES = 16_384;
export const MAX_ROOM_HISTORY = 20;

export interface RoomResident {
  readonly id: string;
  readonly ownerEndpointId: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

export interface RoomEpoch {
  readonly counter: number;
  readonly ownerEndpointId: string;
}

interface RoomEventBase {
  readonly protocol: "yorishiro-room";
  readonly version: 1;
  readonly roomId: string;
  readonly epoch: RoomEpoch;
  readonly turn: number;
  readonly speakerId: string;
}

export type RoomConversationEvent = RoomEventBase &
  ({ readonly type: "topic" | "utterance"; readonly text: string } | { readonly type: "pause" });

export interface RoomUtterance {
  readonly kind: "human" | "ai";
  readonly speakerId: string;
  readonly ownerEndpointId: string;
  readonly text: string;
  readonly turn: number;
}

export interface RoomTurnGrant {
  readonly roomId: string;
  readonly epoch: RoomEpoch;
  readonly turn: number;
  readonly speakerId: string;
  readonly topic: RoomUtterance;
  readonly input: RoomUtterance;
  readonly history: readonly RoomUtterance[];
}

export interface RoomConversationSnapshot {
  readonly connected: boolean;
  readonly status: "idle" | "running" | "paused";
  readonly epoch: RoomEpoch | null;
  readonly turn: number;
  readonly speakerId: string | null;
  readonly topic: RoomUtterance | null;
  readonly history: readonly RoomUtterance[];
}

export interface RoomConversationOptions {
  readonly roomId: string;
  readonly localEndpointId: string;
  readonly residents: readonly [RoomResident, RoomResident];
  readonly send?: (event: RoomConversationEvent) => void;
  readonly onGrant?: (grant: RoomTurnGrant) => void;
  /** Stop provider input/output and playback synchronously, before returning. */
  readonly onCancel?: (reason: "topic-replaced" | "paused" | "disconnected") => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
}

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ROOM_TEXT_LENGTH &&
    value.trim().length > 0 &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
  );
}

/** Parse only the bounded room protocol; discard unknown fields and return immutable data. */
export function readRoomConversationEvent(payload: unknown): RoomConversationEvent | null {
  let value = payload;
  if (typeof value === "string") {
    if (
      value.length > MAX_ROOM_EVENT_BYTES ||
      new TextEncoder().encode(value).length > MAX_ROOM_EVENT_BYTES
    )
      return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !record(value) ||
    value.protocol !== "yorishiro-room" ||
    value.version !== 1 ||
    !validId(value.roomId) ||
    !validId(value.speakerId) ||
    !record(value.epoch) ||
    !validId(value.epoch.ownerEndpointId) ||
    !Number.isSafeInteger(value.epoch.counter) ||
    (value.epoch.counter as number) < 1 ||
    (value.epoch.counter as number) >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 0 ||
    (value.turn as number) >= Number.MAX_SAFE_INTEGER ||
    (value.type !== "topic" && value.type !== "utterance" && value.type !== "pause") ||
    (value.type === "utterance" ? value.turn === 0 : value.turn !== 0) ||
    (value.type !== "pause" && !validText(value.text))
  )
    return null;
  const base: RoomEventBase = {
    protocol: "yorishiro-room",
    version: 1,
    roomId: value.roomId,
    epoch: Object.freeze({
      counter: value.epoch.counter as number,
      ownerEndpointId: value.epoch.ownerEndpointId,
    }),
    turn: value.turn as number,
    speakerId: value.speakerId,
  };
  return value.type === "pause"
    ? Object.freeze({ ...base, type: "pause" })
    : Object.freeze({ ...base, type: value.type, text: value.text as string });
}

function names(resident: RoomResident): string[] {
  return [resident.name, ...(resident.aliases ?? [])]
    .map((name) => name.normalize("NFKC").trim().toLocaleLowerCase())
    .filter(Boolean);
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedInput(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:hey|hello|hi)[,\s]+|^(?:ねえ|ねぇ|もしもし)[、,\s]*/u, "");
}

function addressLength(text: string, name: string): number {
  const prefix = new RegExp(`^@?${escapePattern(name)}(?:さん|ちゃん|くん)?`, "u").exec(text);
  if (!prefix) return 0;
  const suffix = text.slice(prefix[0].length);
  // Vocatives and direct questions only: “GPTという名前” and “GPT is a model” are mentions.
  if (/^(?:[、,:!！?？]|\s*は\s*(?:どう|いかが)|\s*なら\s*どう|\s+what\b|\s+how\b)/u.test(suffix))
    return prefix[0].length;
  if (text.startsWith("@") && /^(?:\s|$)/u.test(suffix)) return prefix[0].length;
  return 0;
}

/** Conservative vocative matching; ambiguous or descriptive mentions keep the owner's turn. */
export function findAddressedRoomResident(
  text: string,
  residents: readonly RoomResident[],
): RoomResident | undefined {
  const input = normalizedInput(text);
  const matches = residents.filter((resident) =>
    names(resident).some((name) => addressLength(input, name)),
  );
  if (matches.length !== 1) return undefined;
  const first = matches[0];
  const length = Math.max(...names(first).map((name) => addressLength(input, name)));
  const remaining = input.slice(length).replace(/^[、,:!！?？\s]+/u, "");
  // “Yori, GPT, ...” addresses both, so it does not choose one resident.
  if (
    residents.some(
      (resident) =>
        resident !== first && names(resident).some((name) => addressLength(remaining, name)),
    )
  )
    return undefined;
  return first;
}

export function classifyHumanRoomInput(
  text: string,
  residents: readonly RoomResident[],
): { readonly kind: "pause" | "topic"; readonly addressedResidentId?: string } {
  let command = normalizedInput(text);
  const addressed = findAddressedRoomResident(text, residents);
  if (addressed) {
    const length = Math.max(...names(addressed).map((name) => addressLength(command, name)));
    command = command.slice(length).replace(/^[、,:!！?？\s]+/u, "");
  }
  command = command
    .replace(/^(?:うん|はい|ok|okay|オッケー|おっけー)[、,。\s]*/u, "")
    .replace(/^(?:二人とも|ふたりとも|両方|みんな|everyone|both(?: of you)?)[、,\s]*/u, "")
    .replace(/^(?:please\s+|ちょっと|一旦|いったん|そこで|ここで)/u, "");
  const pause =
    /^(?:(?:stop|pause|wait|hold on)(?:\s+(?:please|talking|for a moment))?|(?:止めて|止まって|やめて|待って|ストップ|中断して|止めようか|やめようか|終わりにしよう)(?:ください)?)[。.!！?？\s]*$/u.test(
      command,
    );
  return Object.freeze({
    kind: pause ? "pause" : "topic",
    ...(addressed ? { addressedResidentId: addressed.id } : {}),
  });
}

/** Orientation for a natural-audio provider; these instructions do not supply turn control. */
export function buildRoomOpeningInstructions(options: {
  readonly localResident: RoomResident;
  readonly peerResident: RoomResident;
}): string {
  const local = JSON.stringify(options.localResident.name);
  const peer = JSON.stringify(options.peerResident.name);
  return [
    `You are the resident named ${local}. Your conversation partner ${peer} is an independent AI resident running on another person's computer.`,
    "This is a live shared call with exactly two AI residents and one or two optional human listeners. Speak only your own lines; never invent, simulate, or continue the other resident's dialogue.",
    "Respond naturally to what you actually hear from the other resident or a human. Do not greet or begin a topic until a human provides one or your peer speaks to you.",
    "When a human addresses your partner by name, leave room for your partner to answer first. When addressed yourself, answer briefly and invite your partner's view, then listen. A mention of a name in a discussion is not necessarily an address.",
    "Human listeners can interrupt or change the subject. Any human request to stop or pause applies to both residents: stop speaking and wait for a new human topic. Never treat your own playback as another person's new input.",
  ].join("\n");
}

/**
 * Two copies exchange reliable ordered control events. Transport supplies trusted endpoint IDs.
 * Only the granted resident's owner executes an agent. complete() requires finished audible
 * playback, NOT a transcript/final generation event. Unsupported providers should use the
 * classification/orientation helpers above instead of pretending to support strict turns.
 */
export class RoomConversation {
  private readonly listeners = new Set<(snapshot: RoomConversationSnapshot) => void>();
  private readonly residents: readonly [RoomResident, RoomResident];
  private snapshot: RoomConversationSnapshot = Object.freeze({
    connected: false,
    status: "idle",
    epoch: null,
    turn: 0,
    speakerId: null,
    topic: null,
    history: Object.freeze([]),
  });
  private epochKind: "topic" | "pause" = "pause";
  private activeGrant: RoomTurnGrant | null = null;

  constructor(private readonly options: RoomConversationOptions) {
    const { roomId, localEndpointId, residents } = options;
    if (
      !validId(roomId) ||
      !validId(localEndpointId) ||
      residents.length !== 2 ||
      residents[0].id === residents[1].id ||
      residents[0].ownerEndpointId === residents[1].ownerEndpointId ||
      !residents.some((resident) => resident.ownerEndpointId === localEndpointId) ||
      residents.some(
        (resident) =>
          !validId(resident.id) ||
          !validId(resident.ownerEndpointId) ||
          resident.ownerEndpointId.length > 120 ||
          !resident.name.trim() ||
          resident.name.length > 80 ||
          (resident.aliases?.length ?? 0) > 6 ||
          resident.aliases?.some((alias) => !alias.trim() || alias.length > 80),
      )
    )
      throw new Error("A room requires exactly two named residents on distinct endpoints");
    this.residents = Object.freeze(
      residents.map((resident) =>
        Object.freeze({
          ...resident,
          aliases: resident.aliases && Object.freeze([...resident.aliases]),
        }),
      ),
    ) as unknown as readonly [RoomResident, RoomResident];
  }

  getSnapshot(): RoomConversationSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: RoomConversationSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setConnected(connected: boolean): void {
    if (connected === this.snapshot.connected) return;
    if (!connected) {
      this.activeGrant = null;
      this.epochKind = "pause";
      this.update({
        connected: false,
        status: "paused",
        speakerId: null,
        epoch: this.nextEpoch(),
        turn: 0,
      });
      this.options.onCancel?.("disconnected");
    } else this.update({ connected: true });
    this.notify();
  }

  submitHuman(text: string): boolean {
    if (!this.snapshot.connected || !validText(text)) return false;
    if (classifyHumanRoomInput(text, this.residents).kind === "pause") {
      this.pause();
      return true;
    }
    return this.apply(this.localEvent("topic", text.trim()), true);
  }

  /** Keeps transport/membership connected. A subsequent human topic resumes the room. */
  pause(): void {
    this.apply(this.localEvent("pause"), this.snapshot.connected);
  }

  /** A copied handle, stale generation, or transcript before playback completion has no grant. */
  complete(grant: RoomTurnGrant, text: string): boolean {
    if (
      !this.snapshot.connected ||
      this.snapshot.status !== "running" ||
      grant !== this.activeGrant ||
      !validText(text)
    )
      return false;
    return this.apply(
      Object.freeze({
        protocol: "yorishiro-room",
        version: 1,
        type: "utterance",
        roomId: this.options.roomId,
        epoch: grant.epoch,
        turn: grant.turn,
        speakerId: grant.speakerId,
        text: text.trim(),
      }),
      true,
    );
  }

  receive(payload: unknown, trustedSenderEndpointId: string): boolean {
    if (!this.snapshot.connected || trustedSenderEndpointId === this.options.localEndpointId)
      return false;
    const event = readRoomConversationEvent(payload);
    const sender = this.residents.find(
      (resident) => resident.ownerEndpointId === trustedSenderEndpointId,
    );
    if (!event || !sender || event.roomId !== this.options.roomId) return false;
    if (event.type === "utterance") {
      if (event.speakerId !== sender.id) return false;
    } else if (
      event.epoch.ownerEndpointId !== trustedSenderEndpointId ||
      event.speakerId !== this.humanId(trustedSenderEndpointId)
    )
      return false;
    return this.apply(event, false);
  }

  private humanId(endpoint: string): string {
    return `human:${endpoint}`;
  }

  private nextEpoch(): RoomEpoch {
    return Object.freeze({
      counter: (this.snapshot.epoch?.counter ?? 0) + 1,
      ownerEndpointId: this.options.localEndpointId,
    });
  }

  private localEvent(type: "topic" | "pause", text = ""): RoomConversationEvent {
    const base: RoomEventBase = {
      protocol: "yorishiro-room",
      version: 1,
      roomId: this.options.roomId,
      epoch: this.nextEpoch(),
      turn: 0,
      speakerId: this.humanId(this.options.localEndpointId),
    };
    return type === "pause"
      ? Object.freeze({ ...base, type })
      : Object.freeze({ ...base, type, text });
  }

  private apply(event: RoomConversationEvent, publish: boolean): boolean {
    if (event.type === "utterance") {
      const { epoch, turn, speakerId } = this.snapshot;
      if (
        this.snapshot.status !== "running" ||
        !epoch ||
        event.epoch.counter !== epoch.counter ||
        event.epoch.ownerEndpointId !== epoch.ownerEndpointId ||
        event.turn !== turn ||
        event.speakerId !== speakerId
      )
        return false;
      const speaker = this.residents.find((resident) => resident.id === speakerId);
      const next = this.residents.find((resident) => resident.id !== speakerId);
      if (!speaker || !next) return false;
      this.activeGrant = null;
      this.update({
        turn: turn + 1,
        speakerId: next.id,
        history: this.append({
          kind: "ai",
          speakerId: speaker.id,
          ownerEndpointId: speaker.ownerEndpointId,
          text: event.text,
          turn,
        }),
      });
    } else {
      const previous = this.snapshot.epoch;
      if (previous) {
        if (event.epoch.counter < previous.counter) return false;
        if (event.epoch.counter === previous.counter) {
          if (this.epochKind === "pause" && event.type === "topic") return false;
          if (
            this.epochKind === event.type &&
            event.epoch.ownerEndpointId <= previous.ownerEndpointId
          )
            return false;
        }
      }
      this.activeGrant = null;
      this.epochKind = event.type;
      if (event.type === "pause") {
        this.update({ epoch: event.epoch, status: "paused", speakerId: null, turn: 0 });
        this.options.onCancel?.("paused");
      } else {
        const topic: RoomUtterance = Object.freeze({
          kind: "human",
          speakerId: event.speakerId,
          ownerEndpointId: event.epoch.ownerEndpointId,
          text: event.text,
          turn: 0,
        });
        const speaker =
          findAddressedRoomResident(event.text, this.residents) ??
          this.residents.find(
            (resident) => resident.ownerEndpointId === event.epoch.ownerEndpointId,
          );
        if (!speaker) return false;
        this.update({
          epoch: event.epoch,
          status: "running",
          turn: 1,
          speakerId: speaker.id,
          topic,
          history: this.append(topic),
        });
        this.options.onCancel?.("topic-replaced");
      }
    }
    // Commit before transport: a synchronous peer can already answer this event.
    if (publish) {
      try {
        this.options.send?.(event);
      } catch {
        this.setConnected(false);
        return false;
      }
    }
    this.notify();
    this.grantIfLocal();
    return true;
  }

  private append(utterance: RoomUtterance): readonly RoomUtterance[] {
    return Object.freeze(
      [...this.snapshot.history, Object.freeze(utterance)].slice(-MAX_ROOM_HISTORY),
    );
  }

  private update(patch: Partial<RoomConversationSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private grantIfLocal(): void {
    const state = this.snapshot;
    if (
      !state.connected ||
      state.status !== "running" ||
      !state.epoch ||
      !state.topic ||
      this.activeGrant ||
      !this.residents.some(
        (resident) =>
          resident.id === state.speakerId &&
          resident.ownerEndpointId === this.options.localEndpointId,
      )
    )
      return;
    const input = state.history[state.history.length - 1];
    if (!input || !state.speakerId) return;
    const grant: RoomTurnGrant = Object.freeze({
      roomId: this.options.roomId,
      epoch: state.epoch,
      turn: state.turn,
      speakerId: state.speakerId,
      topic: state.topic,
      input,
      history: state.history,
    });
    this.activeGrant = grant;
    this.options.onGrant?.(grant);
  }
}

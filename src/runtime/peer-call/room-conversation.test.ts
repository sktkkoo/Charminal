import { describe, expect, it, vi } from "vitest";
import {
  buildRoomOpeningInstructions,
  classifyHumanRoomInput,
  findAddressedRoomResident,
  MAX_ROOM_EVENT_BYTES,
  MAX_ROOM_HISTORY,
  MAX_ROOM_TEXT_LENGTH,
  RoomConversation,
  type RoomConversationEvent,
  type RoomResident,
  type RoomTurnGrant,
  readRoomConversationEvent,
} from "./room-conversation";

const residents: readonly [RoomResident, RoomResident] = [
  { id: "yori", ownerEndpointId: "host", name: "Yori", aliases: ["より"] },
  { id: "gpt", ownerEndpointId: "guest", name: "GPT" },
];

function pair() {
  const sentA: RoomConversationEvent[] = [];
  const sentB: RoomConversationEvent[] = [];
  const grantsA: RoomTurnGrant[] = [];
  const grantsB: RoomTurnGrant[] = [];
  const cancelA = vi.fn();
  const cancelB = vi.fn();
  const a = new RoomConversation({
    roomId: "room",
    localEndpointId: "host",
    residents,
    send: (event) => sentA.push(event),
    onGrant: (grant) => grantsA.push(grant),
    onCancel: cancelA,
  });
  const b = new RoomConversation({
    roomId: "room",
    localEndpointId: "guest",
    residents,
    send: (event) => sentB.push(event),
    onGrant: (grant) => grantsB.push(grant),
    onCancel: cancelB,
  });
  a.setConnected(true);
  b.setConnected(true);
  return { a, b, sentA, sentB, grantsA, grantsB, cancelA, cancelB };
}

describe("human room instructions", () => {
  it.each([
    ["GPT、音楽についてどう思う？", "gpt"],
    ["GPTはどう？", "gpt"],
    ["より、どう思う？", "yori"],
    ["Hey Yori, what do you think?", "yori"],
    ["@GPT tell us your view", "gpt"],
    ["GPTという名前について話そう", undefined],
    ["GPT is an interesting name", undefined],
    ["What do you think about Yori?", undefined],
    ["Yori, GPT, discuss music", undefined],
  ])("distinguishes address from mention: %s", (input, id) => {
    expect(findAddressedRoomResident(input, residents)?.id).toBe(id);
  });

  it.each([
    "二人とも止めて",
    "より、止めて",
    "GPT, please stop",
    "ちょっと待って",
    "pause",
  ])("treats human stop as applying to the whole room: %s", (input) => {
    expect(classifyHumanRoomInput(input, residents).kind).toBe("pause");
  });

  it("does not mistake discussing stops for a stop command", () => {
    expect(classifyHumanRoomInput("Stop signs are interesting", residents).kind).toBe("topic");
    expect(classifyHumanRoomInput("止めてという言葉の意味は？", residents).kind).toBe("topic");
    expect(classifyHumanRoomInput("GPTはどう？", residents)).toEqual({
      kind: "topic",
      addressedResidentId: "gpt",
    });
  });

  it("orients natural audio without inventing turns or the other resident", () => {
    const instructions = buildRoomOpeningInstructions({
      localResident: residents[0],
      peerResident: residents[1],
    });
    expect(instructions).toContain('resident named "Yori"');
    expect(instructions).toContain('partner "GPT" is an independent AI');
    expect(instructions).toContain("never invent");
    expect(instructions).toContain("stop or pause applies to both");
  });
});

describe("RoomConversation", () => {
  it("grants only the topic owner's resident, then hands actual utterances to the other PC", () => {
    const p = pair();
    expect(p.a.submitHuman("音楽について話そう")).toBe(true);
    expect(p.b.receive(p.sentA[0], "host")).toBe(true);
    expect(p.grantsA).toHaveLength(1);
    expect(p.grantsB).toHaveLength(0);
    const first = p.grantsA[0];
    expect(first.input).toMatchObject({ kind: "human", text: "音楽について話そう" });
    // Transcript arrival alone never causes a handoff. The adapter explicitly completes playback.
    expect(p.a.getSnapshot().turn).toBe(1);
    expect(p.a.complete(first, "旋律の繰り返しが好きです。GPTは？")).toBe(true);
    expect(p.a.complete(first, "duplicate")).toBe(false);
    expect(p.b.receive(p.sentA[1], "host")).toBe(true);
    expect(p.grantsB).toHaveLength(1);
    expect(p.grantsB[0].input).toMatchObject({
      kind: "ai",
      speakerId: "yori",
      text: "旋律の繰り返しが好きです。GPTは？",
    });
    expect(p.b.complete(p.grantsB[0], "繰り返しの中の変化が楽しいですね。")).toBe(true);
    expect(p.a.receive(p.sentB[0], "guest")).toBe(true);
    expect(p.grantsA).toHaveLength(2);
    expect(p.grantsA[1].input.speakerId).toBe("gpt");
  });

  it("a clear name selects the other resident while a mention keeps the owner's resident", () => {
    const p = pair();
    p.a.submitHuman("GPTはどう？");
    p.b.receive(p.sentA[0], "host");
    expect(p.grantsA).toHaveLength(0);
    expect(p.grantsB).toHaveLength(1);
    p.a.submitHuman("GPTという名前について話そう");
    p.b.receive(p.sentA[1], "host");
    expect(p.grantsA).toHaveLength(1);
    expect(p.b.complete(p.grantsB[0], "obsolete reply")).toBe(false);
  });

  it("latest human topic cancels old generation and rejects delayed completion", () => {
    const p = pair();
    p.a.submitHuman("First topic");
    p.b.receive(p.sentA[0], "host");
    const old = p.grantsA[0];
    p.b.submitHuman("New topic from the other human");
    p.a.receive(p.sentB[0], "guest");
    expect(p.cancelA).toHaveBeenLastCalledWith("topic-replaced");
    expect(p.a.complete(old, "old reply")).toBe(false);
    expect(p.a.getSnapshot().topic?.text).toBe("New topic from the other human");
    expect(p.grantsB[0].input.text).toBe("New topic from the other human");
  });

  it("a stop wins against delayed utterances, replay, and concurrent topics while connected", () => {
    const p = pair();
    p.a.submitHuman("First topic");
    p.b.receive(p.sentA[0], "host");
    p.a.complete(p.grantsA[0], "A response still in transit");
    p.b.pause();
    p.a.receive(p.sentB[0], "guest");
    expect(p.b.receive(p.sentA[1], "host")).toBe(false);
    expect(p.b.receive(p.sentA[0], "host")).toBe(false);
    expect(p.a.getSnapshot()).toMatchObject({ connected: true, status: "paused", speakerId: null });
    expect(p.b.getSnapshot()).toMatchObject({ connected: true, status: "paused" });
    expect(p.grantsB).toHaveLength(0);

    const q = pair();
    q.a.submitHuman("Concurrent topic");
    q.b.pause();
    q.a.receive(q.sentB[0], "guest");
    expect(q.b.receive(q.sentA[0], "host")).toBe(false);
    expect(q.a.getSnapshot().status).toBe("paused");
    q.b.submitHuman("A deliberate new topic");
    q.a.receive(q.sentB[1], "guest");
    expect(q.a.getSnapshot().status).toBe("running");
  });

  it("deterministically resolves concurrent topics and never replays a losing epoch", () => {
    const p = pair();
    p.a.submitHuman("Host topic");
    p.b.submitHuman("Guest topic");
    p.a.receive(p.sentB[0], "guest");
    p.b.receive(p.sentA[0], "host");
    expect(p.a.getSnapshot().topic).toEqual(p.b.getSnapshot().topic);
    expect(p.b.getSnapshot().topic?.text).toBe("Host topic");
    expect(p.b.complete(p.grantsB[0], "lost concurrent generation")).toBe(false);
    expect(p.a.receive(p.sentB[0], "guest")).toBe(false);
  });

  it("rejects self-feedback, copied grants, wrong endpoint/speaker/room, and out-of-order turns", () => {
    const p = pair();
    p.a.submitHuman("Theme");
    expect(p.a.receive(p.sentA[0], "host")).toBe(false);
    expect(p.b.receive({ ...p.sentA[0], roomId: "other" }, "host")).toBe(false);
    expect(p.b.receive(p.sentA[0], "intruder")).toBe(false);
    expect(p.b.receive({ ...p.sentA[0], speakerId: "gpt" }, "host")).toBe(false);
    p.b.receive(p.sentA[0], "host");
    expect(p.a.complete({ ...p.grantsA[0] }, "copied handle")).toBe(false);
    p.a.complete(p.grantsA[0], "Actual reply");
    expect(p.b.receive({ ...p.sentA[1], speakerId: "gpt" }, "host")).toBe(false);
    expect(p.b.receive({ ...p.sentA[1], turn: 2 }, "host")).toBe(false);
    expect(p.b.receive(p.sentA[1], "host")).toBe(true);
    expect(p.b.receive(p.sentA[1], "host")).toBe(false);
  });

  it("disconnect cancels synchronously; reconnect waits for another human topic", () => {
    const p = pair();
    p.a.submitHuman("Theme");
    p.a.setConnected(false);
    expect(p.cancelA).toHaveBeenLastCalledWith("disconnected");
    expect(p.a.complete(p.grantsA[0], "too late")).toBe(false);
    expect(p.a.submitHuman("offline")).toBe(false);
    p.a.setConnected(true);
    expect(p.a.getSnapshot().status).toBe("paused");
    expect(p.grantsA).toHaveLength(1);
  });

  it("bounds history, preserves the current topic, and gives immutable UI subscriptions", () => {
    const p = pair();
    const listener = vi.fn();
    const unsubscribe = p.a.subscribe(listener);
    for (let index = 0; index < MAX_ROOM_HISTORY + 5; index++) p.a.submitHuman(`Theme ${index}`);
    const snapshot = p.a.getSnapshot();
    expect(snapshot.history).toHaveLength(MAX_ROOM_HISTORY);
    expect(snapshot.topic?.text).toBe(`Theme ${MAX_ROOM_HISTORY + 4}`);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.history[0])).toBe(true);
    unsubscribe();
    const count = listener.mock.calls.length;
    p.a.pause();
    expect(listener).toHaveBeenCalledTimes(count);
  });

  it("fails closed when transport publication throws", () => {
    const onGrant = vi.fn();
    const onCancel = vi.fn();
    const room = new RoomConversation({
      roomId: "room",
      localEndpointId: "host",
      residents,
      send: () => {
        throw new Error("closed channel");
      },
      onGrant,
      onCancel,
    });
    room.setConnected(true);
    expect(room.submitHuman("Theme")).toBe(false);
    expect(room.getSnapshot()).toMatchObject({ connected: false, status: "paused" });
    expect(onGrant).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenLastCalledWith("disconnected");
  });

  it("requires two independent endpoint owners", () => {
    expect(
      () =>
        new RoomConversation({
          roomId: "room",
          localEndpointId: "host",
          residents: [residents[0], { ...residents[1], ownerEndpointId: "host" }],
        }),
    ).toThrow();
  });
});

describe("room wire validation", () => {
  it("round-trips bounded events and strips fields unrelated to the conversation", () => {
    const p = pair();
    p.a.submitHuman("Theme");
    const wire = { ...p.sentA[0], script: "untrusted" };
    expect(readRoomConversationEvent(JSON.stringify(wire))).toEqual(p.sentA[0]);
    expect(Object.isFrozen(readRoomConversationEvent(wire)?.epoch)).toBe(true);
  });

  it("rejects malformed, oversized, empty, invalid-counter, and wrong-protocol data", () => {
    const p = pair();
    p.a.submitHuman("Theme");
    const base = p.sentA[0];
    for (const value of [
      null,
      [],
      "{",
      "x".repeat(MAX_ROOM_EVENT_BYTES + 1),
      { ...base, version: 2 },
      { ...base, roomId: "" },
      { ...base, protocol: "other" },
      { ...base, text: " " },
      { ...base, text: "x".repeat(MAX_ROOM_TEXT_LENGTH + 1) },
      { ...base, text: "bad\u0000text" },
      { ...base, epoch: { counter: -1, ownerEndpointId: "host" } },
      { ...base, epoch: { counter: Infinity, ownerEndpointId: "host" } },
      { ...base, turn: 1 },
      { ...base, type: "utterance", turn: 0 },
    ]) {
      expect(readRoomConversationEvent(value)).toBeNull();
    }
    expect(p.a.submitHuman("x".repeat(MAX_ROOM_TEXT_LENGTH + 1))).toBe(false);
  });
});

it("recognizes the demonstrated human stop phrase without treating discussion of stopping as a command", () => {
  expect(classifyHumanRoomInput("オッケー、二人ともそこで止めようか", []).kind).toBe("pause");
  expect(classifyHumanRoomInput("そこで止めようかという案はどう思う？", []).kind).toBe("topic");
});

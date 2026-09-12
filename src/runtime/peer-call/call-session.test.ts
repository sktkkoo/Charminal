import { describe, expect, it } from "vitest";
import {
  type CallAdmission,
  type CallParticipant,
  CallSession,
  type MediaConsent,
} from "./call-session";

const AI: CallParticipant = { id: "ai-a", ownerEndpointId: "pc-a", kind: "ai" };
const ALL_MEDIA: MediaConsent = { sendAudio: true, sendCamera: true, sendScreen: true };
const NO_MEDIA: MediaConsent = { sendAudio: false, sendCamera: false, sendScreen: false };

function invite(session: CallSession, participant = AI): CallAdmission {
  const result = session.invite(participant);
  if (!result.ok) throw new Error(result.reason);
  return result.admission;
}

function join(session: CallSession, participant = AI): CallAdmission {
  const admission = invite(session, participant);
  expect(session.accept(admission, ALL_MEDIA)).toEqual({ ok: true });
  expect(session.join(admission)).toEqual({ ok: true });
  return admission;
}

describe("CallSession", () => {
  it("keeps human/AI identity separate from endpoint ownership and locally derived origin", () => {
    const session = new CallSession("call-a", "pc-a");
    join(session);
    join(session, { id: "ai-b", ownerEndpointId: "pc-a", kind: "ai" });
    join(session, { id: "person-a", ownerEndpointId: "pc-a", kind: "human" });
    const remoteClaim = {
      id: "ai-c",
      ownerEndpointId: "pc-b",
      kind: "ai" as const,
      origin: "local",
    };
    join(session, remoteClaim);

    expect(
      session.listParticipants().map(({ participant, origin }) => [participant.id, origin]),
    ).toEqual([
      ["ai-a", "local"],
      ["ai-b", "local"],
      ["person-a", "local"],
      ["ai-c", "remote"],
    ]);
    expect(session.getParticipant("ai-c")?.participant).not.toHaveProperty("origin");
  });

  it("requires acceptance and joining before any media publication", () => {
    const session = new CallSession("call-a", "pc-a");
    const admission = invite(session);
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
    expect(session.canPublish(admission, "sendAudio")).toBe(false);
    expect(session.setConsent(admission, ALL_MEDIA)).toEqual({
      ok: false,
      reason: "unexpected-state",
    });
    expect(session.join(admission)).toEqual({ ok: false, reason: "unexpected-state" });

    expect(session.accept(admission, ALL_MEDIA)).toEqual({ ok: true });
    expect(session.getParticipant(AI.id)?.state).toBe("accepted");
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
    expect(session.canPublish(admission, "sendCamera")).toBe(false);
    expect(session.join(admission)).toEqual({ ok: true });
    expect(session.getParticipant(AI.id)?.media).toEqual(ALL_MEDIA);
  });

  it("does not infer media consent from joining, kind, or local ownership", () => {
    const session = new CallSession("call-a", "pc-a");
    const admission = invite(session);
    session.accept(admission);
    session.join(admission);
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
    expect(session.canPublish(admission, "sendScreen")).toBe(false);
  });

  it("replaces consent fail-closed and does not share a mutable caller object", () => {
    const session = new CallSession("call-a", "pc-a");
    const admission = join(session);
    const consent = { sendScreen: true };
    session.setConsent(admission, consent);
    consent.sendScreen = false;
    expect(session.canPublish(admission, "sendAudio")).toBe(false);
    expect(session.canPublish(admission, "sendCamera")).toBe(false);
    expect(session.canPublish(admission, "sendScreen")).toBe(true);
    session.setConsent(admission, {});
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
  });

  it("does not enable capabilities from truthy non-booleans", () => {
    const session = new CallSession("call-a", "pc-a");
    const admission = invite(session);
    session.accept(admission, { sendAudio: "yes", sendCamera: 1 } as unknown as MediaConsent);
    session.join(admission);
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
  });

  it("copies identity and returns frozen observations instead of mutable state", () => {
    const session = new CallSession("call-a", "pc-a");
    const participant = { ...AI };
    const admission = join(session, participant);
    const snapshot = session.getParticipant(AI.id);
    participant.ownerEndpointId = "pc-b";
    expect(snapshot?.origin).toBe("local");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.participant)).toBe(true);
    expect(Object.isFrozen(snapshot?.media)).toBe(true);
    expect(Object.isFrozen(session.listParticipants())).toBe(true);
    expect(Object.isFrozen(admission)).toBe(true);
    session.leave(admission);
    expect(snapshot?.media.sendAudio).toBe(true);
    expect(session.canPublish(admission, "sendAudio")).toBe(false);
  });

  it("revokes on leave and requires fresh consent with a fresh handle when rejoining", () => {
    const session = new CallSession("call-a", "pc-a");
    const oldAdmission = join(session);
    session.leave(oldAdmission);
    expect(session.getParticipant(AI.id)?.state).toBe("left");
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
    expect(session.canPublish(oldAdmission, "sendAudio")).toBe(false);

    const newAdmission = invite(session);
    expect(newAdmission.revision).toBeGreaterThan(oldAdmission.revision);
    expect(session.join(newAdmission)).toEqual({ ok: false, reason: "unexpected-state" });
    session.accept(newAdmission);
    session.join(newAdmission);
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
    session.setConsent(newAdmission, { sendAudio: true });

    for (const action of [
      () => session.accept(oldAdmission, ALL_MEDIA),
      () => session.join(oldAdmission),
      () => session.setConsent(oldAdmission, ALL_MEDIA),
      () => session.leave(oldAdmission),
    ]) {
      expect(action()).toEqual({ ok: false, reason: "stale-admission" });
    }
    expect(session.canPublish(oldAdmission, "sendAudio")).toBe(false);
    expect(session.canPublish(newAdmission, "sendAudio")).toBe(true);
    expect(session.canPublish(newAdmission, "sendCamera")).toBe(false);
  });

  it("invalidates cancelled or declined invitations before acceptance", () => {
    const session = new CallSession("call-a", "pc-a");
    const admission = invite(session);
    expect(session.leave(admission)).toEqual({ ok: true });
    expect(session.accept(admission, ALL_MEDIA)).toEqual({ ok: false, reason: "stale-admission" });
    expect(session.getParticipant(AI.id)?.media).toEqual(NO_MEDIA);
  });

  it("rejects copied handles and handles from a previous session even with identical IDs", () => {
    const previousSession = new CallSession("reused-display-id", "pc-a");
    const previousAdmission = join(previousSession);
    previousSession.end();
    const session = new CallSession("reused-display-id", "pc-a");
    const admission = invite(session);
    expect(admission).toEqual(previousAdmission);
    for (const stale of [previousAdmission, { ...admission }]) {
      expect(session.accept(stale, ALL_MEDIA)).toEqual({ ok: false, reason: "stale-admission" });
      expect(session.canPublish(stale, "sendAudio")).toBe(false);
    }
    expect(session.accept(admission)).toEqual({ ok: true });
  });

  it("cannot use a handle for another participant in the same session", () => {
    const session = new CallSession("call-a", "pc-a");
    const admission = join(session);
    const other = invite(session, { ...AI, id: "ai-b" });
    const forged = { ...admission, participantId: other.participantId };
    expect(session.accept(forged, ALL_MEDIA)).toEqual({ ok: false, reason: "stale-admission" });
    expect(session.getParticipant(other.participantId)?.state).toBe("invited");
  });

  it("ends all lifecycle stages without leaving media or admission usable", () => {
    const session = new CallSession("call-a", "pc-a");
    const invited = invite(session);
    const accepted = invite(session, { ...AI, id: "ai-b" });
    session.accept(accepted, ALL_MEDIA);
    const joined = join(session, { ...AI, id: "ai-c" });
    session.end();
    session.end();

    expect(session.getState()).toBe("ended");
    for (const admission of [invited, accepted, joined]) {
      expect(session.getParticipant(admission.participantId)?.state).toBe("left");
      expect(session.getParticipant(admission.participantId)?.media).toEqual(NO_MEDIA);
      expect(session.canPublish(admission, "sendAudio")).toBe(false);
      expect(session.accept(admission, ALL_MEDIA)).toEqual({ ok: false, reason: "ended" });
      expect(session.join(admission)).toEqual({ ok: false, reason: "ended" });
      expect(session.setConsent(admission, ALL_MEDIA)).toEqual({ ok: false, reason: "ended" });
      expect(session.leave(admission)).toEqual({ ok: false, reason: "ended" });
    }
    expect(session.invite(AI)).toEqual({ ok: false, reason: "ended" });
  });

  it("preserves participant identity across invitations and does not replace active membership", () => {
    const session = new CallSession("call-a", "pc-a");
    const admission = join(session);
    expect(session.invite(AI)).toEqual({ ok: false, reason: "already-present" });
    expect(session.canPublish(admission, "sendAudio")).toBe(true);
    session.leave(admission);
    expect(session.invite({ ...AI, ownerEndpointId: "pc-b" })).toEqual({
      ok: false,
      reason: "participant-conflict",
    });
    expect(session.invite({ ...AI, kind: "human" })).toEqual({
      ok: false,
      reason: "participant-conflict",
    });
    expect(session.getParticipant(AI.id)?.participant).toEqual(AI);
  });

  it("rejects missing identifiers without adding membership", () => {
    expect(() => new CallSession("", "pc-a")).toThrow();
    expect(() => new CallSession("call-a", " ")).toThrow();
    const session = new CallSession("call-a", "pc-a");
    expect(session.invite({ ...AI, id: "" })).toEqual({ ok: false, reason: "invalid-participant" });
    expect(session.invite({ ...AI, ownerEndpointId: " " })).toEqual({
      ok: false,
      reason: "invalid-participant",
    });
    expect(session.listParticipants()).toEqual([]);
  });
});

/** Local membership bookkeeping only; this module does not authenticate peers or move media. */

export interface CallParticipant {
  readonly id: string;
  readonly ownerEndpointId: string;
  readonly kind: "human" | "ai";
}

/** Publication intent only. Receiving content and AI/tool access require separate policy. */
export interface MediaConsent {
  readonly sendAudio: boolean;
  readonly sendCamera: boolean;
  readonly sendScreen: boolean;
}

export type MembershipState = "invited" | "accepted" | "joined" | "left";

/**
 * An in-process handle, not a network token or credential. Only the exact object
 * issued by invite() is accepted; reconstructing its fields does not restore it.
 */
export interface CallAdmission {
  readonly sessionId: string;
  readonly participantId: string;
  readonly revision: number;
}

export interface MembershipSnapshot {
  readonly participant: CallParticipant;
  readonly origin: "local" | "remote";
  readonly state: MembershipState;
  readonly media: MediaConsent;
}

type Failure = {
  readonly ok: false;
  readonly reason:
    | "ended"
    | "invalid-participant"
    | "participant-conflict"
    | "already-present"
    | "stale-admission"
    | "unexpected-state";
};

export type CallTransition = { readonly ok: true } | Failure;
export type CallInvitation = { readonly ok: true; readonly admission: CallAdmission } | Failure;

interface Membership {
  readonly participant: CallParticipant;
  readonly admission: CallAdmission;
  state: MembershipState;
  consent: MediaConsent;
}

const NO_MEDIA: MediaConsent = Object.freeze({
  sendAudio: false,
  sendCamera: false,
  sendScreen: false,
});

function copyConsent(consent: Partial<MediaConsent>): MediaConsent {
  return Object.freeze({
    sendAudio: consent.sendAudio === true,
    sendCamera: consent.sendCamera === true,
    sendScreen: consent.sendScreen === true,
  });
}

function validId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Deterministic state transitions with no IO, clock, renderer, or agent execution.
 * The host supplies endpoint identities; remote payloads must never supply trusted
 * localEndpointId or be passed to these methods without an authorization boundary.
 */
export class CallSession {
  private readonly members = new Map<string, Membership>();
  private nextRevision = 0;
  private ended = false;

  constructor(
    readonly sessionId: string,
    private readonly localEndpointId: string,
  ) {
    if (!validId(sessionId) || !validId(localEndpointId)) {
      throw new Error("Call session and local endpoint IDs must be nonempty");
    }
  }

  invite(participant: CallParticipant): CallInvitation {
    if (this.ended) return { ok: false, reason: "ended" };
    if (
      !validId(participant.id) ||
      !validId(participant.ownerEndpointId) ||
      (participant.kind !== "human" && participant.kind !== "ai")
    ) {
      return { ok: false, reason: "invalid-participant" };
    }
    const previous = this.members.get(participant.id);
    if (
      previous &&
      (previous.participant.ownerEndpointId !== participant.ownerEndpointId ||
        previous.participant.kind !== participant.kind)
    ) {
      return { ok: false, reason: "participant-conflict" };
    }
    if (previous && previous.state !== "left") {
      return { ok: false, reason: "already-present" };
    }

    const admission = Object.freeze({
      sessionId: this.sessionId,
      participantId: participant.id,
      revision: ++this.nextRevision,
    });
    // Copy only the identity fields; a supplied origin or other metadata has no authority.
    this.members.set(participant.id, {
      participant: Object.freeze({
        id: participant.id,
        ownerEndpointId: participant.ownerEndpointId,
        kind: participant.kind,
      }),
      admission,
      state: "invited",
      consent: NO_MEDIA,
    });
    return { ok: true, admission };
  }

  accept(admission: CallAdmission, consent: Partial<MediaConsent> = {}): CallTransition {
    const member = this.resolve(admission);
    if ("ok" in member) return member;
    if (member.state !== "invited") return { ok: false, reason: "unexpected-state" };
    member.consent = copyConsent(consent);
    member.state = "accepted";
    return { ok: true };
  }

  join(admission: CallAdmission): CallTransition {
    const member = this.resolve(admission);
    if ("ok" in member) return member;
    if (member.state !== "accepted") return { ok: false, reason: "unexpected-state" };
    member.state = "joined";
    return { ok: true };
  }

  /** Replace consent, rather than merge it: omitted capabilities are revoked. */
  setConsent(admission: CallAdmission, consent: Partial<MediaConsent>): CallTransition {
    const member = this.resolve(admission);
    if ("ok" in member) return member;
    if (member.state !== "accepted" && member.state !== "joined") {
      return { ok: false, reason: "unexpected-state" };
    }
    member.consent = copyConsent(consent);
    return { ok: true };
  }

  /** Also handles invitation cancellation/decline before joining. */
  leave(admission: CallAdmission): CallTransition {
    const member = this.resolve(admission);
    if ("ok" in member) return member;
    member.consent = NO_MEDIA;
    member.state = "left";
    return { ok: true };
  }

  end(): void {
    this.ended = true;
    for (const member of this.members.values()) {
      member.consent = NO_MEDIA;
      member.state = "left";
    }
  }

  getState(): "open" | "ended" {
    return this.ended ? "ended" : "open";
  }

  /** Recheck at the point of use; a previously returned snapshot is not authority. */
  canPublish(admission: CallAdmission, capability: keyof MediaConsent): boolean {
    const member = this.resolve(admission);
    return !("ok" in member) && member.state === "joined" && member.consent[capability] === true;
  }

  getParticipant(participantId: string): MembershipSnapshot | undefined {
    const member = this.members.get(participantId);
    if (!member) return undefined;
    return Object.freeze({
      participant: member.participant,
      origin: member.participant.ownerEndpointId === this.localEndpointId ? "local" : "remote",
      state: member.state,
      media: !this.ended && member.state === "joined" ? member.consent : NO_MEDIA,
    });
  }

  listParticipants(): readonly MembershipSnapshot[] {
    return Object.freeze(
      Array.from(this.members.keys(), (id) => this.getParticipant(id)).filter(
        (member): member is MembershipSnapshot => member !== undefined,
      ),
    );
  }

  private resolve(admission: CallAdmission): Membership | Failure {
    if (this.ended) return { ok: false, reason: "ended" };
    const member = this.members.get(admission.participantId);
    if (!member || member.admission !== admission || member.state === "left") {
      return { ok: false, reason: "stale-admission" };
    }
    return member;
  }
}

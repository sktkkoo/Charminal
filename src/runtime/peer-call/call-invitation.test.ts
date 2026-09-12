import { describe, expect, it } from "vitest";
import {
  createCallInvitation,
  INVITATION_TTL_MS,
  readCallConsent,
  readCallInvitation,
} from "./call-invitation";

const now = 1_000_000;
describe("native invitation protocol", () => {
  it("preserves the exact SDP binding and expiry for a trusted direct exchange", () => {
    expect(
      readCallInvitation(createCallInvitation("opaque transport", now + 1000), now),
    ).toMatchObject({ signal: "opaque transport", expiresAt: now + 1000 });
  });
  it("rejects expiry, distant future, oversized payloads and unversioned prototypes", () => {
    for (const value of [
      createCallInvitation("sdp", now),
      createCallInvitation("sdp", now + INVITATION_TTL_MS + 31000),
      "x".repeat(144000),
      JSON.stringify({ version: 1, signal: "sdp" }),
    ])
      expect(() => readCallInvitation(value, now)).toThrow();
  });
  it("accepts consent only as strict bounded values, never arbitrary actions", () => {
    const consent = {
      version: 1,
      revision: 1,
      name: "Yori",
      allowRemoteAi: true,
      aiActive: false,
      microphoneActive: false,
    };
    expect(readCallConsent(JSON.stringify(consent))).toEqual(consent);
    for (const value of [
      { ...consent, allowRemoteAi: "true" },
      { ...consent, revision: -1 },
      { ...consent, revision: 1.5 },
      { ...consent, name: "\nspoof" },
      { ...consent, run: "shell" },
    ])
      expect(readCallConsent(JSON.stringify(value))).toBeNull();
  });
});

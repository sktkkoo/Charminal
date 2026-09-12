const MAX_BYTES = 140 * 1024;
export const INVITATION_TTL_MS = 5 * 60_000;

export interface CallInvitationCode {
  protocol: "yorishiro-call";
  version: 1;
  expiresAt: number;
  signal: string;
}

/** Directly exchange codes with a trusted person; this is not account authentication. */
export function createCallInvitation(
  signal: string,
  expiresAt = Date.now() + INVITATION_TTL_MS,
): string {
  return JSON.stringify({ protocol: "yorishiro-call", version: 1, expiresAt, signal });
}

export function readCallInvitation(text: string, now = Date.now()): CallInvitationCode {
  if (text.length > MAX_BYTES) throw new Error("招待が大きすぎます。");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("招待コードを確認してください。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("招待形式が違います。");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    record.protocol !== "yorishiro-call" ||
    record.version !== 1 ||
    typeof record.signal !== "string" ||
    record.signal.length > 128 * 1024 ||
    typeof record.expiresAt !== "number" ||
    !Number.isSafeInteger(record.expiresAt)
  ) {
    throw new Error("対応していない招待形式です。");
  }
  if (record.expiresAt <= now || record.expiresAt > now + INVITATION_TTL_MS + 30_000) {
    throw new Error("招待の期限が切れています。新しい招待を作ってください。");
  }
  return record as unknown as CallInvitationCode;
}

export interface CallConsent {
  version: 1;
  revision: number;
  name: string;
  allowRemoteAi: boolean;
  aiActive: boolean;
  microphoneActive: boolean;
}

export function readCallConsent(text: string): CallConsent | null {
  if (text.length > 2048) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 6 ||
    item.version !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 0 ||
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.length > 64 ||
    Array.from(item.name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    typeof item.allowRemoteAi !== "boolean" ||
    typeof item.aiActive !== "boolean" ||
    typeof item.microphoneActive !== "boolean"
  )
    return null;
  return item as unknown as CallConsent;
}

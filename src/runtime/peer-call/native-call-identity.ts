import { invoke } from "@tauri-apps/api/core";
import { type CallIdentity, CallIdentityError } from "./call-identity";

export interface NativeCallDescriptor {
  identityId: string;
  publicKey: string;
}
export interface NativeIdentityReservation {
  /** Granted only by the transaction that creates a durable, previously absent reservation. */
  allowCreate: boolean;
  descriptor: NativeCallDescriptor | null;
}
export interface NativeCallIdentityStore {
  reserve(endpoint: string): Promise<NativeIdentityReservation>;
  pin(endpoint: string, descriptor: NativeCallDescriptor): Promise<void>;
}
export interface NativeCallIdentityPort {
  prepare(
    endpoint: string,
    expected: string | null,
    allowCreate: boolean,
  ): Promise<NativeCallDescriptor>;
  authenticate(
    endpoint: string,
    expected: string,
    socketUrl: string,
    challenge: string,
  ): Promise<{
    type: "authenticate";
    publicKey: string;
    signature: string;
  }>;
}

const NATIVE_ERRORS = [
  "native-context-invalid",
  "native-key-invalid",
  "native-key-missing",
  "native-key-mismatch",
  "native-interaction-required",
  "native-key-protection-unavailable",
  "native-key-protection-attribute-missing",
  "native-key-exportable",
  "native-key-algorithm-invalid",
  "native-key-access-invalid",
  "native-key-create-invalid-parameters",
  "native-key-create-interaction-required",
  "native-key-create-duplicate",
  "native-key-create-unsupported",
  "native-key-create-unavailable",
  "native-signature-invalid",
  "native-unavailable",
  "native-signing-unavailable",
] as const;

function nativeError(error: unknown): CallIdentityError {
  const code = NATIVE_ERRORS.find((code) => code === error) ?? "native-unavailable";
  return new CallIdentityError(code);
}

const port: NativeCallIdentityPort = {
  prepare: (endpoint, expectedPublicKey, allowCreate) =>
    invoke("peer_call_identity_prepare", { endpoint, expectedPublicKey, allowCreate }),
  authenticate: (endpoint, expectedPublicKey, socketUrl, challenge) =>
    invoke("peer_call_identity_authenticate", {
      endpoint,
      expectedPublicKey,
      socketUrl,
      challenge,
    }),
};

export async function supportsNativeCallIdentity(): Promise<boolean> {
  try {
    return await invoke<boolean>("peer_call_identity_supported");
  } catch (error) {
    // A failed capability/IPC check is never permission to fall back to WebKit key deserialization.
    throw nativeError(error);
  }
}

export function validNativeDescriptor(value: unknown): value is NativeCallDescriptor {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    "identityId" in value &&
    typeof value.identityId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.identityId) &&
    "publicKey" in value &&
    typeof value.publicKey === "string" &&
    /^B[A-Za-z0-9_-]{86}$/.test(value.publicKey)
  );
}

/** Only public descriptors cross IPC. A failed native operation is not retried by this identity. */
export async function loadNativeCallIdentity(
  endpoint: string,
  store: NativeCallIdentityStore,
  native = port,
): Promise<CallIdentity> {
  const reservation = await store.reserve(endpoint);
  if (reservation.descriptor !== null && !validNativeDescriptor(reservation.descriptor))
    throw new CallIdentityError("native-key-invalid");
  let descriptor: NativeCallDescriptor;
  try {
    descriptor = await native.prepare(
      endpoint,
      reservation.descriptor?.publicKey ?? null,
      reservation.allowCreate,
    );
  } catch (error) {
    throw nativeError(error);
  }
  if (!validNativeDescriptor(descriptor)) throw new CallIdentityError("native-key-invalid");
  if (
    reservation.descriptor &&
    (reservation.descriptor.publicKey !== descriptor.publicKey ||
      reservation.descriptor.identityId !== descriptor.identityId)
  )
    throw new CallIdentityError("native-key-mismatch");
  // Before networking sees an identity, pin it durably. Reservation survives interruption/failure.
  await store.pin(endpoint, descriptor);
  let failure: CallIdentityError | null = null;
  return Object.freeze({
    identityId: descriptor.identityId,
    publicKey: descriptor.publicKey,
    async authenticate(socketUrl: string, challenge: string) {
      if (failure) throw failure;
      try {
        const reply = await native.authenticate(
          endpoint,
          descriptor.publicKey,
          socketUrl,
          challenge,
        );
        if (
          reply.type !== "authenticate" ||
          reply.publicKey !== descriptor.publicKey ||
          !/^[A-Za-z0-9_-]{86}$/.test(reply.signature)
        )
          throw "native-signature-invalid";
        return reply;
      } catch (error) {
        failure = nativeError(error);
        throw failure;
      }
    },
  });
}

export const MANAGED_CALL_PROTOCOL = "yorishiro-call-v2";
export const CALL_IDENTITY_ID = /^[A-Za-z0-9_-]{43}$/;
export const CALL_ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function managedCallEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const parts = url.hostname.split(".").map(Number);
  const privateV4 =
    parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  const local = url.hostname === "localhost" || url.hostname === "[::1]" || privateV4;
  if (
    endpoint.length > 2048 ||
    url.pathname !== "/v2/rooms" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "wss:" || (url.protocol === "ws:" && local))
  )
    throw new Error("Invalid managed call endpoint");
  return url.href;
}

export function isManagedCallEndpoint(endpoint: string): boolean {
  try {
    managedCallEndpoint(endpoint);
    return true;
  } catch {
    return false;
  }
}

export function managedInvitationRoom(invitation: string): string | null {
  const match = /^yri2_([^_]+)_([A-Za-z0-9_-]{22})$/.exec(invitation);
  return match && CALL_ROOM_ID.test(match[1]) ? match[1] : null;
}

function encode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface CallIdentity {
  readonly identityId: string;
  readonly publicKey: string;
  authenticate(
    socketUrl: string,
    challenge: string,
  ): Promise<{ type: "authenticate"; publicKey: string; signature: string }>;
}

/** The adapter keeps tests independent of browser storage. Keys are never serialized to JSON. */
export interface CallIdentityStore {
  load(endpoint: string): Promise<CryptoKeyPair | null>;
  saveIfAbsent(endpoint: string, keys: CryptoKeyPair): Promise<CryptoKeyPair>;
}

const IDENTITY_STAGES = [
  "crypto-unavailable",
  "storage-open",
  "storage-blocked",
  "storage-read",
  "storage-write",
  "key-generate",
  "key-validate",
  "public-export",
  "identity-digest",
] as const;
export type CallIdentityStage = (typeof IDENTITY_STAGES)[number];
const IDENTITY_ERROR_NAMES = [
  "AbortError",
  "ConstraintError",
  "DataCloneError",
  "DataError",
  "InvalidAccessError",
  "InvalidStateError",
  "NotAllowedError",
  "NotFoundError",
  "NotSupportedError",
  "OperationError",
  "QuotaExceededError",
  "ReadOnlyError",
  "SecurityError",
  "SyntaxError",
  "TransactionInactiveError",
  "UnknownError",
] as const;
type IdentityErrorName = (typeof IDENTITY_ERROR_NAMES)[number];

function identityErrorName(error: unknown): IdentityErrorName {
  try {
    const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
    return IDENTITY_ERROR_NAMES.find((allowed) => allowed === name) ?? "UnknownError";
  } catch {
    return "UnknownError";
  }
}

/** Diagnostic metadata only. Never retain the original error, which may contain key/storage data. */
export class CallIdentityError extends Error {
  readonly detail: IdentityErrorName;
  constructor(
    readonly stage: CallIdentityStage,
    error?: unknown,
  ) {
    super("通話の識別情報を準備できませんでした。");
    this.name = "CallIdentityError";
    this.detail = identityErrorName(error);
  }
}

/** Only locally constructed, bounded diagnostic fields may reach the native error UI. */
export function callIdentityErrorMessage(
  error: unknown,
  fallback = "通話の識別情報を準備できませんでした。",
): string {
  if (
    !(error instanceof CallIdentityError) ||
    !IDENTITY_STAGES.includes(error.stage) ||
    !IDENTITY_ERROR_NAMES.includes(error.detail)
  )
    return fallback;
  return `${fallback} [identity:${error.stage}:${error.detail}]`;
}

/** Recover only the allowlisted diagnostic suffix when rendering a serialized error. */
export function callIdentityDiagnostic(message: string): string | null {
  const match = / \[identity:([a-z-]+):([A-Za-z]+)\]$/.exec(message);
  if (
    !match ||
    !IDENTITY_STAGES.some((stage) => stage === match[1]) ||
    !IDENTITY_ERROR_NAMES.some((name) => name === match[2])
  )
    return null;
  return match[0];
}

async function identityStage<T>(
  stage: CallIdentityStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof CallIdentityError ? error : new CallIdentityError(stage, error);
  }
}

let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("yorishiro-call-identity", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("identities");
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = null;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(new CallIdentityError("storage-open", request.error));
      request.onblocked = () => reject(new CallIdentityError("storage-blocked"));
    }).catch((error: unknown) => {
      database = null;
      throw error instanceof CallIdentityError
        ? error
        : new CallIdentityError("storage-open", error);
    });
  return database;
}

const persistentStore: CallIdentityStore = {
  async load(endpoint) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("identities", "readonly");
      const request = tx.objectStore("identities").get(endpoint);
      tx.oncomplete = () => resolve(request.result ?? null);
      request.onerror = () => reject(new CallIdentityError("storage-read", request.error));
      tx.onabort = tx.onerror = () => reject(new CallIdentityError("storage-read", tx.error));
    });
  },
  async saveIfAbsent(endpoint, keys) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("identities", "readwrite");
      const store = tx.objectStore("identities");
      const request = store.get(endpoint);
      let selected = keys;
      request.onsuccess = () => {
        try {
          if (request.result !== undefined) selected = request.result;
          else {
            const write = store.add(keys, endpoint);
            write.onerror = () => reject(new CallIdentityError("storage-write", write.error));
          }
        } catch (error) {
          // CryptoKey serialization can throw synchronously in WebKit's success callback.
          // Reject before aborting so its DataCloneError is not replaced by a generic abort.
          reject(new CallIdentityError("storage-write", error));
          try {
            tx.abort();
          } catch {}
        }
      };
      request.onerror = () => reject(new CallIdentityError("storage-write", request.error));
      tx.oncomplete = () => resolve(selected);
      tx.onabort = tx.onerror = () => reject(new CallIdentityError("storage-write", tx.error));
    });
  },
};
const identities = new WeakMap<CallIdentityStore, Map<string, Promise<CallIdentity>>>();

/** One stable, endpoint-scoped identity. Storage failure never silently replaces the identity. */
export function getCallIdentity(
  endpoint: string,
  store = persistentStore,
  webCrypto = globalThis.crypto,
): Promise<CallIdentity> {
  const normalized = managedCallEndpoint(endpoint);
  let cached = identities.get(store);
  if (!cached) {
    cached = new Map();
    identities.set(store, cached);
  }
  const existing = cached.get(normalized);
  if (existing) return existing;
  const pending = (async (): Promise<CallIdentity> => {
    if (!webCrypto?.subtle) throw new CallIdentityError("crypto-unavailable");
    let keys = await identityStage("storage-read", () => store.load(normalized));
    if (!keys) {
      const generated = await identityStage("key-generate", () =>
        webCrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
          "sign",
          "verify",
        ]),
      );
      keys = await identityStage("storage-write", () => store.saveIfAbsent(normalized, generated));
    }
    const validatedKeys = keys;
    await identityStage("key-validate", () => {
      if (
        !validatedKeys.privateKey ||
        validatedKeys.privateKey.type !== "private" ||
        validatedKeys.privateKey.extractable ||
        validatedKeys.privateKey.algorithm.name !== "ECDSA" ||
        (validatedKeys.privateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
        !validatedKeys.privateKey.usages.includes("sign") ||
        !validatedKeys.publicKey ||
        validatedKeys.publicKey.type !== "public"
      )
        throw new CallIdentityError("key-validate");
    });
    const raw = await identityStage("public-export", () =>
      webCrypto.subtle.exportKey("raw", validatedKeys.publicKey),
    );
    if (raw.byteLength !== 65 || new Uint8Array(raw)[0] !== 4)
      throw new CallIdentityError("public-export");
    const publicKey = encode(raw);
    const identityId = encode(
      await identityStage("identity-digest", () => webCrypto.subtle.digest("SHA-256", raw)),
    );
    const privateKey = keys.privateKey;
    return Object.freeze({
      identityId,
      publicKey,
      async authenticate(socketUrl: string, challenge: string) {
        const url = new URL(socketUrl);
        const origin = new URL(normalized);
        const roomId = url.pathname.slice("/v2/rooms/".length);
        if (
          url.origin !== origin.origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !(
            (url.pathname.startsWith("/v2/rooms/") && CALL_ROOM_ID.test(roomId)) ||
            url.pathname === `/v2/users/${identityId}`
          ) ||
          !CALL_IDENTITY_ID.test(challenge)
        )
          throw new Error("Invalid call authentication context");
        const message = new TextEncoder().encode(
          `${MANAGED_CALL_PROTOCOL}\n${url.pathname}\n${challenge}`,
        );
        const signature = await webCrypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          privateKey,
          message,
        );
        return { type: "authenticate" as const, publicKey, signature: encode(signature) };
      },
    });
  })();
  cached.set(normalized, pending);
  void pending.catch(() => {
    if (cached.get(normalized) === pending) cached.delete(normalized);
  });
  return pending;
}

/** Per-socket admission: a challenge may be answered once, never after authentication. */
export class CallSocketAuthentication {
  private challenged = false;
  authenticated = false;
  constructor(
    private identity: CallIdentity,
    private socketUrl: string,
  ) {}
  async receive(
    message: Record<string, unknown>,
    send: (message: object) => void,
  ): Promise<boolean> {
    if (message.type === "challenge") {
      if (
        this.challenged ||
        this.authenticated ||
        Object.keys(message).length !== 2 ||
        typeof message.challenge !== "string" ||
        !CALL_IDENTITY_ID.test(message.challenge)
      )
        throw new Error("Invalid call challenge");
      this.challenged = true;
      send(await this.identity.authenticate(this.socketUrl, message.challenge));
      return true;
    }
    if (message.type === "authenticated") {
      if (
        !this.challenged ||
        this.authenticated ||
        Object.keys(message).length !== 2 ||
        message.identityId !== this.identity.identityId
      )
        throw new Error("Invalid authenticated identity");
      this.authenticated = true;
      return true;
    }
    if (!this.authenticated) throw new Error("Call socket is not authenticated");
    return false;
  }
}

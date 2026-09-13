/** Bounded binary avatar exchange. No model URLs, pack code, or executable scripts cross the room. */
export const MAX_AVATAR_BYTES = 50 * 1024 * 1024;
export const MAX_AVATAR_PACKET_BYTES = 16 * 1024;
export const AVATAR_TRANSFER_TIMEOUT_MS = 60_000;

export class AvatarSizeLimitError extends Error {
  constructor(readonly actualBytes: number) {
    super(`Avatar size ${(actualBytes / 1024 / 1024).toFixed(2)} MiB exceeds the 50 MiB limit`);
    this.name = "AvatarSizeLimitError";
  }
}
const HEADER_BYTES = 32;
const CHUNK_BYTES = MAX_AVATAR_PACKET_BYTES - HEADER_BYTES;
const PACKET_MAGIC = 0x31525641;
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ARRAY_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  nodes: 2_048,
  meshes: 1_024,
  accessors: 4_096,
  bufferViews: 8_192,
  images: 128,
  textures: 128,
  materials: 256,
  skins: 128,
  animations: 128,
  buffers: 1,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsigned(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function imagePixels(bytes: Uint8Array, mimeType: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixels = (width: number, height: number): number =>
    width > 0 && height > 0 && width <= 8_192 && height <= 8_192 && width * height <= 16_777_216
      ? width * height
      : 0;
  if (mimeType === "image/png") {
    if (
      bytes.length < 24 ||
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(12) !== 0x49484452
    )
      return 0;
    return pixels(view.getUint32(16), view.getUint32(20));
  }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 0;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return 0;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return 0;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return 0;
      return pixels(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }
  return 0;
}

/** Resource preflight for self-contained VRM 0/1 GLBs; the VRM loader still validates semantics. */
export function validateAvatarGlb(bytes: ArrayBuffer): boolean {
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength < 20 ||
    bytes.byteLength > MAX_AVATAR_BYTES
  )
    return false;
  try {
    const header = new DataView(bytes);
    if (
      header.getUint32(0, true) !== GLB_MAGIC ||
      header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== bytes.byteLength
    )
      return false;
    let offset = 12;
    let json: unknown;
    let binaryBytes = 0;
    let binaryOffset = 0;
    let sawBinary = false;
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) return false;
      const size = header.getUint32(offset, true);
      const type = header.getUint32(offset + 4, true);
      if (size % 4 !== 0 || offset + 8 + size > bytes.byteLength) return false;
      if (type === JSON_CHUNK) {
        if (offset !== 12 || json !== undefined || size > MAX_JSON_BYTES) return false;
        json = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes, offset + 8, size)),
        );
      } else if (type === BIN_CHUNK) {
        if (json === undefined || sawBinary) return false;
        binaryBytes = size;
        binaryOffset = offset + 8;
        sawBinary = true;
      } else return false;
      offset += 8 + size;
    }
    if (
      !isRecord(json) ||
      !isRecord(json.asset) ||
      json.asset.version !== "2.0" ||
      !isRecord(json.extensions) ||
      (!isRecord(json.extensions.VRM) && !isRecord(json.extensions.VRMC_vrm))
    )
      return false;

    // A URI anywhere (including extension resources) could escape the transferred bytes.
    const stack: { value: unknown; depth: number }[] = [{ value: json, depth: 0 }];
    let visited = 0;
    while (stack.length) {
      const entry = stack.pop();
      if (!entry || entry.depth > 48 || ++visited > 200_000) return false;
      if (Array.isArray(entry.value)) {
        if (entry.value.length > 20_000) return false;
        for (const value of entry.value) stack.push({ value, depth: entry.depth + 1 });
      } else if (isRecord(entry.value)) {
        for (const [key, value] of Object.entries(entry.value)) {
          if (key.toLowerCase() === "uri" || key === "__proto__" || key === "constructor")
            return false;
          stack.push({ value, depth: entry.depth + 1 });
        }
      }
    }
    for (const [key, limit] of Object.entries(ARRAY_LIMITS)) {
      if (json[key] !== undefined && (!Array.isArray(json[key]) || json[key].length > limit))
        return false;
    }
    const buffers = (json.buffers ?? []) as unknown[];
    let declaredBufferBytes = 0;
    if (buffers.length) {
      const buffer = buffers[0];
      if (
        !isRecord(buffer) ||
        !unsigned(buffer.byteLength) ||
        buffer.byteLength > binaryBytes ||
        binaryBytes - buffer.byteLength > 3
      )
        return false;
      declaredBufferBytes = buffer.byteLength;
    } else if (binaryBytes) return false;

    const views = (json.bufferViews ?? []) as unknown[];
    for (const view of views) {
      if (
        !isRecord(view) ||
        view.buffer !== 0 ||
        !unsigned(view.byteLength) ||
        !unsigned(view.byteOffset ?? 0) ||
        ((view.byteOffset as number) ?? 0) + view.byteLength > declaredBufferBytes
      )
        return false;
    }
    let accessorElements = 0;
    for (const accessor of (json.accessors ?? []) as unknown[]) {
      if (!isRecord(accessor) || !unsigned(accessor.count) || accessor.count > 1_000_000)
        return false;
      accessorElements += accessor.count;
      if (accessorElements > 8_000_000) return false;
      if (
        accessor.bufferView !== undefined &&
        (!unsigned(accessor.bufferView) || accessor.bufferView >= views.length)
      )
        return false;
    }
    let texturePixels = 0;
    for (const image of (json.images ?? []) as unknown[]) {
      if (
        !isRecord(image) ||
        !unsigned(image.bufferView) ||
        image.bufferView >= views.length ||
        (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")
      )
        return false;
      const view = views[image.bufferView];
      if (!isRecord(view)) return false;
      const pixels = imagePixels(
        new Uint8Array(
          bytes,
          binaryOffset + ((view.byteOffset as number) ?? 0),
          view.byteLength as number,
        ),
        image.mimeType,
      );
      texturePixels += pixels;
      if (!pixels || texturePixels > 134_217_728) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface AvatarTransferOptions {
  /** False means temporary backpressure; caller should also check channel readyState. */
  readonly onSend: (packet: ArrayBuffer) => boolean;
  readonly onError?: (message: string) => void;
  readonly timeoutMs?: number;
}

interface IncomingAvatar {
  readonly transfer: number;
  readonly bytes: Uint8Array;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
}

/** One instance per dedicated reliable ordered data channel. A reconnect creates a new instance. */
export class AvatarTransfer {
  private readonly session = crypto.getRandomValues(new Uint32Array(2));
  private readonly listeners = new Set<(bytes: ArrayBuffer) => void>();
  private readonly timeoutMs: number;
  private remoteSession: string | null = null;
  private latestIncomingTransfer = 0;
  private nextOutgoingTransfer = 0;
  private incoming: IncomingAvatar | null = null;
  private sending = false;
  private closed = false;
  private wakeSender: (() => void) | null = null;

  constructor(private readonly options: AvatarTransferOptions) {
    this.timeoutMs = options.timeoutMs ?? AVATAR_TRANSFER_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000)
      throw new Error("Invalid avatar transfer timeout");
  }

  subscribe(listener: (bytes: ArrayBuffer) => void): () => void {
    if (!this.closed) this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** No blob URL is retained here. The consumer owns URL creation and revocation. */
  accept(packet: ArrayBuffer): boolean {
    if (this.closed) return false;
    if (
      !(packet instanceof ArrayBuffer) ||
      packet.byteLength <= HEADER_BYTES ||
      packet.byteLength > MAX_AVATAR_PACKET_BYTES
    )
      return this.reject("Invalid avatar packet size");
    const header = new DataView(packet);
    const session = `${header.getUint32(4, true)}:${header.getUint32(8, true)}`;
    const transfer = header.getUint32(12, true);
    const size = header.getUint32(16, true);
    const sequence = header.getUint32(20, true);
    const length = header.getUint32(24, true);
    if (
      header.getUint32(0, true) !== PACKET_MAGIC ||
      header.getUint32(28, true) !== 0 ||
      session === `${this.session[0]}:${this.session[1]}` ||
      (this.remoteSession !== null && session !== this.remoteSession) ||
      transfer === 0 ||
      size < 20 ||
      size > MAX_AVATAR_BYTES ||
      length !== packet.byteLength - HEADER_BYTES ||
      sequence * CHUNK_BYTES >= size ||
      length !== Math.min(CHUNK_BYTES, size - sequence * CHUNK_BYTES)
    )
      return this.reject("Invalid avatar packet header");
    if (!this.incoming) {
      if (sequence !== 0 || transfer <= this.latestIncomingTransfer)
        return this.reject("Stale or out-of-order avatar transfer");
      this.remoteSession = session;
      this.latestIncomingTransfer = transfer;
      this.incoming = {
        transfer,
        bytes: new Uint8Array(size),
        sequence: 0,
        timer: setTimeout(() => this.reject("Avatar transfer timed out"), this.timeoutMs),
      };
    }
    const active = this.incoming;
    if (
      active.transfer !== transfer ||
      active.bytes.length !== size ||
      active.sequence !== sequence
    )
      return this.reject("Out-of-order avatar packet");
    active.bytes.set(new Uint8Array(packet, HEADER_BYTES), sequence * CHUNK_BYTES);
    active.sequence++;
    if (sequence * CHUNK_BYTES + length < size) {
      return true;
    }
    clearTimeout(active.timer);
    this.incoming = null;
    const bytes = active.bytes.buffer as ArrayBuffer;
    if (!validateAvatarGlb(bytes))
      return this.reject("The received avatar is not a supported self-contained VRM");
    for (const listener of this.listeners) listener(bytes);
    return true;
  }

  async send(bytes: ArrayBuffer): Promise<void> {
    if (this.closed) throw new Error("Avatar transfer is closed");
    if (this.sending) throw new Error("An avatar transfer is already in progress");
    if (bytes instanceof ArrayBuffer && bytes.byteLength > MAX_AVATAR_BYTES)
      throw new AvatarSizeLimitError(bytes.byteLength);
    if (!validateAvatarGlb(bytes))
      throw new Error("The avatar must be a self-contained VRM GLB within 50 MiB");
    if (this.nextOutgoingTransfer === 0xffffffff)
      throw new Error("Avatar transfer sequence exhausted");
    // The caller can replace its asset while queued packets still reference this fixed copy.
    const source = new Uint8Array(bytes.slice(0));
    const transfer = ++this.nextOutgoingTransfer;
    const deadline = Date.now() + this.timeoutMs;
    this.sending = true;
    try {
      for (
        let offset = 0, sequence = 0;
        offset < source.length;
        offset += CHUNK_BYTES, sequence++
      ) {
        const length = Math.min(CHUNK_BYTES, source.length - offset);
        const packet = new ArrayBuffer(HEADER_BYTES + length);
        const header = new DataView(packet);
        header.setUint32(0, PACKET_MAGIC, true);
        header.setUint32(4, this.session[0], true);
        header.setUint32(8, this.session[1], true);
        header.setUint32(12, transfer, true);
        header.setUint32(16, source.length, true);
        header.setUint32(20, sequence, true);
        header.setUint32(24, length, true);
        new Uint8Array(packet, HEADER_BYTES).set(source.subarray(offset, offset + length));
        while (true) {
          if (this.closed) throw new Error("Avatar transfer is closed");
          if (Date.now() >= deadline)
            throw new Error("Avatar transfer timed out waiting for the channel");
          if (this.options.onSend(packet)) break;
          await this.waitForCapacity();
        }
      }
    } finally {
      this.sending = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.incoming) clearTimeout(this.incoming.timer);
    this.incoming = null;
    this.listeners.clear();
    this.wakeSender?.();
  }

  private reject(message: string): false {
    if (this.incoming) clearTimeout(this.incoming.timer);
    this.incoming = null;
    this.options.onError?.(message);
    return false;
  }

  private waitForCapacity(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSender = null;
        resolve();
      }, 25);
      this.wakeSender = () => {
        clearTimeout(timer);
        this.wakeSender = null;
        resolve();
      };
    });
  }
}

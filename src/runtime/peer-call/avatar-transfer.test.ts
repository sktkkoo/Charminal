import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_TRANSFER_TIMEOUT_MS,
  AvatarSizeLimitError,
  AvatarTransfer,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_PACKET_BYTES,
  validateAvatarGlb,
} from "./avatar-transfer";

function sizedGlb(size: number): ArrayBuffer {
  const bytes = new ArrayBuffer(size);
  const header = new DataView(bytes);
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0" },
      extensions: { VRMC_vrm: {} },
      buffers: [{ byteLength: size - 1024 }],
    }),
  );
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, size, true);
  header.setUint32(12, 996, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, 996).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  header.setUint32(1016, size - 1024, true);
  header.setUint32(1020, 0x004e4942, true);
  return bytes;
}

function glb(overrides: Record<string, unknown> = {}, binary = new Uint8Array()): ArrayBuffer {
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0" },
      extensions: { VRMC_vrm: { specVersion: "1.0" } },
      ...(binary.length ? { buffers: [{ byteLength: binary.length }] } : {}),
      ...overrides,
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + jsonLength + (binary.length ? 8 + binaryLength : 0));
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, jsonLength).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  if (binary.length) {
    header.setUint32(20 + jsonLength, binaryLength, true);
    header.setUint32(24 + jsonLength, 0x004e4942, true);
    new Uint8Array(bytes, 28 + jsonLength, binary.length).set(binary);
  }
  return bytes;
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function patch(packet: ArrayBuffer, offset: number, value: number): ArrayBuffer {
  const copy = packet.slice(0);
  new DataView(copy).setUint32(offset, value, true);
  return copy;
}

async function packets(bytes = glb({}, new Uint8Array(40_000))) {
  const result: ArrayBuffer[] = [];
  const sender = new AvatarTransfer({
    onSend: (packet) => {
      result.push(packet);
      return true;
    },
  });
  await sender.send(bytes);
  return { sender, packets: result, bytes };
}

afterEach(() => vi.useRealTimers());

describe("avatar GLB resource validation", () => {
  it("accepts the 50 MiB boundary and rejects any bytes over it", () => {
    expect(validateAvatarGlb(sizedGlb(50 * 1024 * 1024))).toBe(true);
    expect(validateAvatarGlb(sizedGlb(50 * 1024 * 1024 + 4))).toBe(false);
  });

  it("accepts self-contained VRM 0 and VRM 1 GLB containers", () => {
    expect(validateAvatarGlb(glb())).toBe(true);
    expect(validateAvatarGlb(glb({ extensions: { VRM: {} } }, new Uint8Array(100)))).toBe(true);
  });

  it("rejects non-VRM, JSON-only glTF, wrong headers, truncation, and oversized files", () => {
    const valid = glb();
    for (const bytes of [
      new ArrayBuffer(0),
      new ArrayBuffer(MAX_AVATAR_BYTES + 1),
      glb({ extensions: {} }),
      glb({ asset: { version: "1.0" } }),
      valid.slice(0, -1),
      patch(valid, 0, 0),
      patch(valid, 4, 1),
      patch(valid, 8, valid.byteLength + 4),
      patch(valid, 12, 0xfffffff0),
      patch(valid, 16, 0x004e4942),
    ]) {
      expect(validateAvatarGlb(bytes)).toBe(false);
    }
  });

  it("rejects external or data URIs including resources hidden in extensions", () => {
    for (const uri of [
      "https://example.com/avatar.bin",
      "file:///etc/passwd",
      "data:image/png;base64,AAAA",
      "texture.png",
    ]) {
      expect(validateAvatarGlb(glb({ extensions: { VRMC_vrm: {}, custom: { uri } } }))).toBe(false);
    }
    expect(validateAvatarGlb(glb({ buffers: [{ byteLength: 8, uri: "avatar.bin" }] }))).toBe(false);
  });

  it("bounds structure, accessor counts, texture counts, and embedded buffer ranges", () => {
    expect(validateAvatarGlb(glb({ nodes: Array.from({ length: 2_049 }, () => ({})) }))).toBe(
      false,
    );
    expect(validateAvatarGlb(glb({ textures: Array.from({ length: 129 }, () => ({})) }))).toBe(
      false,
    );
    expect(validateAvatarGlb(glb({ accessors: [{ count: 1_000_001 }] }))).toBe(false);
    expect(
      validateAvatarGlb(
        glb({ accessors: Array.from({ length: 9 }, () => ({ count: 1_000_000 })) }),
      ),
    ).toBe(false);
    expect(
      validateAvatarGlb(
        glb({ bufferViews: [{ buffer: 0, byteOffset: 20, byteLength: 90 }] }, new Uint8Array(100)),
      ),
    ).toBe(false);
    expect(validateAvatarGlb(glb({ buffers: [{ byteLength: 101 }] }, new Uint8Array(100)))).toBe(
      false,
    );
    let nested: unknown = {};
    for (let index = 0; index < 60; index++) nested = { nested };
    expect(validateAvatarGlb(glb({ extras: nested }))).toBe(false);
  });

  it("limits decoded texture dimensions before handing image bytes to a loader", () => {
    const data = {
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }],
      images: [{ bufferView: 0, mimeType: "image/png" }],
    };
    expect(validateAvatarGlb(glb(data, png(2_048, 2_048)))).toBe(true);
    expect(validateAvatarGlb(glb(data, png(50_000, 50_000)))).toBe(false);
    expect(validateAvatarGlb(glb(data, png(0, 1)))).toBe(false);
    expect(validateAvatarGlb(glb(data, new Uint8Array(24)))).toBe(false);
    expect(
      validateAvatarGlb(
        glb(
          { ...data, images: Array.from({ length: 9 }, () => data.images[0]) },
          png(4_096, 4_096),
        ),
      ),
    ).toBe(false);
  });
});

describe("AvatarTransfer", () => {
  it("sends and reassembles a 46 MiB model using bounded packets", async () => {
    const bytes = sizedGlb(46 * 1024 * 1024);
    const received = vi.fn();
    const receiver = new AvatarTransfer({ onSend: () => true });
    receiver.subscribe(received);
    const sender = new AvatarTransfer({
      onSend: (packet) => {
        expect(packet.byteLength).toBeLessThanOrEqual(MAX_AVATAR_PACKET_BYTES);
        return receiver.accept(packet);
      },
    });
    await sender.send(bytes);
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0][0].byteLength).toBe(bytes.byteLength);
    expect(validateAvatarGlb(received.mock.calls[0][0])).toBe(true);
    sender.close();
    receiver.close();
  });

  it("reports an oversize model before sending any packet", async () => {
    const onSend = vi.fn(() => true);
    const sender = new AvatarTransfer({ onSend });
    await expect(sender.send(new ArrayBuffer(MAX_AVATAR_BYTES + 1))).rejects.toBeInstanceOf(
      AvatarSizeLimitError,
    );
    expect(onSend).not.toHaveBeenCalled();
    sender.close();
  });

  it("keeps the extended default deadline bounded to 60 seconds", async () => {
    vi.useFakeTimers();
    const sender = new AvatarTransfer({ onSend: () => false });
    const failure = expect(sender.send(glb())).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(AVATAR_TRANSFER_TIMEOUT_MS - 30_000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
    sender.close();
  });

  it("reassembles only complete bounded packets and supports a newer avatar", async () => {
    const p = await packets();
    const listener = vi.fn();
    const receiver = new AvatarTransfer({ onSend: () => true });
    receiver.subscribe(listener);
    expect(p.packets.length).toBeGreaterThan(1);
    for (const [index, packet] of p.packets.entries()) {
      expect(packet.byteLength).toBeLessThanOrEqual(MAX_AVATAR_PACKET_BYTES);
      expect(receiver.accept(packet)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(index === p.packets.length - 1 ? 1 : 0);
    }
    expect(new Uint8Array(listener.mock.calls[0][0])).toEqual(new Uint8Array(p.bytes));
    const previousCount = p.packets.length;
    await p.sender.send(glb({ nodes: [] }));
    expect(receiver.accept(p.packets[previousCount])).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    receiver.close();
    p.sender.close();
  });

  it("rejects replay, self-echo, mixed sessions and out-of-order chunks", async () => {
    const p = await packets();
    const other = await packets();
    const receiver = new AvatarTransfer({ onSend: () => true });
    expect(p.sender.accept(p.packets[0])).toBe(false);
    expect(receiver.accept(p.packets[1])).toBe(false);
    expect(receiver.accept(p.packets[0])).toBe(true);
    expect(receiver.accept(other.packets[1])).toBe(false);
    expect(receiver.accept(p.packets[0])).toBe(false);
    receiver.close();
    const completeReceiver = new AvatarTransfer({ onSend: () => true });
    for (const packet of p.packets) expect(completeReceiver.accept(packet)).toBe(true);
    expect(completeReceiver.accept(p.packets[0])).toBe(false);
    completeReceiver.close();
  });

  it("rejects size, sequence, session, and reserved-header tampering without emitting bytes", async () => {
    const p = await packets();
    const listener = vi.fn();
    for (const packet of [
      new ArrayBuffer(16),
      new ArrayBuffer(MAX_AVATAR_PACKET_BYTES + 1),
      patch(p.packets[0], 0, 0),
      patch(p.packets[0], 12, 0),
      patch(p.packets[0], 16, MAX_AVATAR_BYTES + 1),
      patch(p.packets[0], 20, 1),
      patch(p.packets[0], 24, 1),
      patch(p.packets[0], 28, 1),
    ]) {
      const receiver = new AvatarTransfer({ onSend: () => true });
      receiver.subscribe(listener);
      expect(receiver.accept(packet)).toBe(false);
      receiver.close();
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("validates received GLB content rather than trusting the sending endpoint", async () => {
    const p = await packets(glb());
    const receiver = new AvatarTransfer({ onSend: () => true });
    const listener = vi.fn();
    receiver.subscribe(listener);
    expect(receiver.accept(patch(p.packets[0], 32, 0))).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    receiver.close();
  });

  it("expires an incomplete transfer and rejects its delayed chunks", async () => {
    vi.useFakeTimers();
    const p = await packets();
    const onError = vi.fn();
    const receiver = new AvatarTransfer({ onSend: () => true, onError, timeoutMs: 100 });
    expect(receiver.accept(p.packets[0])).toBe(true);
    await vi.advanceTimersByTimeAsync(101);
    expect(onError).toHaveBeenCalledWith("Avatar transfer timed out");
    expect(receiver.accept(p.packets[1])).toBe(false);
    expect(receiver.accept(p.packets[0])).toBe(false);
    receiver.close();
  });

  it("awaits backpressure, retains its fixed source, and never starts a parallel transfer", async () => {
    vi.useFakeTimers();
    const received: ArrayBuffer[] = [];
    let ready = false;
    const sender = new AvatarTransfer({
      onSend: (packet) => {
        if (!ready) return false;
        received.push(packet);
        return true;
      },
    });
    const source = glb();
    const original = source.slice(0);
    const pending = sender.send(source);
    await expect(sender.send(source)).rejects.toThrow("already in progress");
    new Uint8Array(source).fill(0);
    expect(received).toHaveLength(0);
    ready = true;
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    const receiver = new AvatarTransfer({ onSend: () => true });
    const listener = vi.fn();
    receiver.subscribe(listener);
    expect(receiver.accept(received[0])).toBe(true);
    expect(new Uint8Array(listener.mock.calls[0][0])).toEqual(new Uint8Array(original));
    sender.close();
    receiver.close();
  });

  it("fails bounded on permanent backpressure and closes a waiting sender immediately", async () => {
    vi.useFakeTimers();
    const sender = new AvatarTransfer({ onSend: () => false, timeoutMs: 100 });
    const failure = expect(sender.send(glb())).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    const pending = expect(sender.send(glb())).rejects.toThrow("closed");
    sender.close();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unsubscribes and closes without emitting a late completion", async () => {
    const p = await packets();
    const receiver = new AvatarTransfer({ onSend: () => true });
    const listener = vi.fn();
    const unsubscribe = receiver.subscribe(listener);
    expect(receiver.accept(p.packets[0])).toBe(true);
    unsubscribe();
    receiver.close();
    for (const packet of p.packets.slice(1)) expect(receiver.accept(packet)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    await expect(receiver.send(glb())).rejects.toThrow("closed");
  });
});

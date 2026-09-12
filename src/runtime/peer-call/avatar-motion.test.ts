import type { VRM, VRMPose } from "@pixiv/three-vrm";
import { Group, Quaternion, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  AVATAR_MOTION_BONES,
  AVATAR_MOTION_EXPRESSIONS,
  AVATAR_MOTION_PACKET_BYTES,
  AvatarMotionBuffer,
  type AvatarMotionFrame,
  type AvatarMotionPose,
  avatarMotionVrmPose,
  captureAvatarMotion,
  decodeAvatarMotion,
  encodeAvatarMotion,
} from "./avatar-motion";
import { isLocalCallAvatarUrl } from "./call-avatar";

function pose(angle = 0): AvatarMotionPose {
  return {
    bones: AVATAR_MOTION_BONES.map(() =>
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle).toArray(),
    ),
    hips: [0.02, 0.03, -0.04],
    root: [0, 0.0012, 0],
    gaze: [12.5, -6.3],
    expressions: AVATAR_MOTION_EXPRESSIONS.map(() => 0.4),
  };
}

function frame(sequence = 1, timestampMs = 0, angle = 0): AvatarMotionFrame {
  return { sequence, timestampMs, pose: pose(angle) };
}

function vrm(normalized: VRMPose, metaVersion: "0" | "1" = "1") {
  const scene = new Group();
  scene.position.y = 0.003;
  return {
    meta: { metaVersion },
    scene,
    humanoid: { getNormalizedPose: vi.fn(() => normalized) },
    lookAt: { yaw: 17, pitch: -4 },
    expressionManager: { getValue: vi.fn((name: string) => (name === "happy" ? 0.7 : 0)) },
  } as unknown as VRM;
}

describe("native avatar motion capture and codec", () => {
  it("captures real normalized bone rotations, final expressions, gaze, and breathing without modifying the resident", () => {
    const headRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.25).toArray();
    const normalized: VRMPose = {
      head: { rotation: headRotation },
      hips: { rotation: [0, 0, 0, 1], position: [0.1, 0, 0] },
    };
    const source = vrm(normalized);
    const captured = captureAvatarMotion(source, 9, 50);
    expect(captured.sequence).toBe(9);
    expect(captured.pose.bones[AVATAR_MOTION_BONES.indexOf("head")]).toEqual(headRotation);
    expect(captured.pose.bones[AVATAR_MOTION_BONES.indexOf("leftHand")]).toBeNull();
    expect(captured.pose.hips).toEqual([0.1, 0, 0]);
    expect(captured.pose.root).toEqual([0, 0.003, 0]);
    expect(captured.pose.gaze).toEqual([17, -4]);
    expect(captured.pose.expressions[0]).toBe(0.7);
    expect(source.expressionManager?.getValue).not.toHaveBeenCalledWith("aa");
    headRotation[0] = 0;
    expect(captured.pose.bones[5]?.[0]).not.toBe(0);
    expect(source.scene.parent).toBeNull();
  });

  it("converts opposite-facing VRM 0 normalized coordinates and restores them for a VRM 0 receiver", () => {
    const rotation = new Quaternion()
      .setFromAxisAngle(new Vector3(1, 0, 1).normalize(), 0.5)
      .toArray();
    const normalized: VRMPose = { head: { rotation }, hips: { position: [0.1, 0.2, 0.3] } };
    const captured = captureAvatarMotion(vrm(normalized, "0"), 0, 0);
    expect(captured.pose.bones[5]).toEqual([-rotation[0], rotation[1], -rotation[2], rotation[3]]);
    expect(avatarMotionVrmPose(captured.pose, true).head?.rotation).toEqual(rotation);
    expect(avatarMotionVrmPose(captured.pose, true).hips?.position).toEqual([0.1, 0.2, 0.3]);
    expect(avatarMotionVrmPose(captured.pose, false).hips?.position).toEqual([-0.1, 0.2, -0.3]);
  });

  it("keeps a complete full-humanoid snapshot below 6 KB per second at 10 Hz", () => {
    const input = frame(0xffffffff, 123456.75, 0.82);
    input.pose.bones[3] = null;
    const encoded = encodeAvatarMotion(input);
    expect(encoded.byteLength).toBe(AVATAR_MOTION_PACKET_BYTES);
    expect(encoded.byteLength * 10).toBeLessThan(6_000);
    const decoded = decodeAvatarMotion(encoded);
    expect(decoded?.sequence).toBe(0xffffffff);
    expect(decoded?.timestampMs).toBe(123456.75);
    expect(decoded?.pose.bones[3]).toBeNull();
    expect(decoded?.pose.root).toEqual(input.pose.root);
    expect(decoded?.pose.gaze).toEqual(input.pose.gaze);
    expect(decoded?.pose.bones[5]?.[1]).toBeCloseTo(input.pose.bones[5]?.[1] ?? 0, 4);
    expect(decoded?.pose.expressions[0]).toBeCloseTo(0.4, 2);
  });

  it("rejects unsupported versions, lengths, flags, and masks", () => {
    const valid = encodeAvatarMotion(frame());
    for (const [offset, value] of [
      [0, 0],
      [2, 2],
      [3, 1],
      [22, 255],
    ]) {
      const invalid = valid.slice(0);
      new DataView(invalid).setUint8(offset, value);
      expect(decodeAvatarMotion(invalid)).toBeNull();
    }
    expect(decodeAvatarMotion(valid.slice(1))).toBeNull();
    expect(decodeAvatarMotion(new ArrayBuffer(valid.byteLength + 1))).toBeNull();
    expect(decodeAvatarMotion("malicious" as unknown as ArrayBuffer)).toBeNull();
  });

  it("rejects impossible rotations, hidden absent-bone payload, invalid clocks and positions", () => {
    const valid = encodeAvatarMotion(frame());
    const corruptions = [
      (view: DataView) => view.setFloat64(8, Number.NaN, true),
      (view: DataView) => view.setFloat64(8, -1, true),
      (view: DataView) => view.setInt16(23, 30_000, true),
      (view: DataView) => view.setInt16(39 + 6, 0, true),
      (view: DataView) => view.setUint8(16, 0),
      (view: DataView) => view.setInt16(39, -32768, true),
    ];
    for (const corrupt of corruptions) {
      const bytes = valid.slice(0);
      corrupt(new DataView(bytes));
      expect(decodeAvatarMotion(bytes)).toBeNull();
    }
  });

  it("rejects non-finite capture values and malformed frames rather than producing corrupt rendering state", () => {
    const source = vrm({ head: { rotation: [0, 0, 0, 0] } });
    expect(() => captureAvatarMotion(source, 1, 10)).toThrow();
    const input = frame();
    input.pose.expressions[0] = Number.NaN;
    expect(() => encodeAvatarMotion(input)).toThrow();
    input.pose = pose();
    input.pose.bones.pop();
    expect(() => encodeAvatarMotion(input)).toThrow();
    expect(() => encodeAvatarMotion({ ...frame(), sequence: -1 })).toThrow();
  });

  it("transfers only rest-relative hips position, never the sender's complete bone translations or model proportions", () => {
    const source = vrm({
      head: { rotation: [0, 0, 0, 1], position: [0, 50, 0] },
      hips: { position: [0.1, 0, 0] },
    });
    const received = avatarMotionVrmPose(captureAvatarMotion(source, 1, 10).pose, false);
    expect(received.head).toEqual({ rotation: [0, 0, 0, 1] });
    expect(received.hips?.position).toEqual([0.1, 0, 0]);
  });
});

describe("native avatar jitter buffer", () => {
  it("interpolates quaternion rotations and expressions on the receiver's delayed timeline", () => {
    const buffer = new AvatarMotionBuffer(100);
    const a = frame(1, 1000, 0);
    const b = frame(2, 1100, Math.PI / 2);
    a.pose.expressions[0] = 0;
    b.pose.expressions[0] = 1;
    expect(buffer.push(a, 2000)).toBe(true);
    expect(buffer.push(b, 2100)).toBe(true);
    const sampled = buffer.sample(2150);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    expect(sampled?.bones[5]?.[1]).toBeCloseTo(expected.y);
    expect(sampled?.bones[5]?.[3]).toBeCloseTo(expected.w);
    expect(sampled?.expressions[0]).toBeCloseTo(0.5);
  });

  it("accepts bounded reordering and counter wrap but rejects replays, clock regressions, and timestamp attacks", () => {
    const buffer = new AvatarMotionBuffer();
    expect(buffer.push(frame(0xfffffffe, 100), 100)).toBe(true);
    expect(buffer.push(frame(0, 300), 300)).toBe(true);
    expect(buffer.push(frame(0xffffffff, 200), 310)).toBe(true);
    expect(buffer.push(frame(0xffffffff, 200), 320)).toBe(false);
    expect(buffer.push(frame(1, 250), 330)).toBe(false);
    expect(buffer.push(frame(1, 999_999), 330)).toBe(false);
    expect(buffer.push(frame(1, 400), 299)).toBe(false);
    expect(buffer.push(frame(1, 400), 400)).toBe(true);
  });

  it("does not extrapolate across packet loss or invent a long sweep after a stall", () => {
    const buffer = new AvatarMotionBuffer(100);
    buffer.push(frame(1, 100, 0), 100);
    buffer.push(frame(2, 800, Math.PI / 2), 800);
    expect(buffer.sample(700)?.bones[5]).toEqual([0, 0, 0, 1]);
    expect(buffer.sample(1000)?.bones[5]?.[1]).toBeCloseTo(Math.SQRT1_2);
    expect(buffer.sample(3000)).toBeNull();
  });

  it("owns copies at both boundaries so callers cannot mutate accepted remote state", () => {
    const buffer = new AvatarMotionBuffer();
    const original = frame();
    buffer.push(original, 0);
    original.pose.bones[5] = [0, 1, 0, 0];
    original.pose.expressions[0] = 1;
    const sampled = buffer.sample(100);
    expect(sampled?.bones[5]).toEqual([0, 0, 0, 1]);
    expect(sampled?.expressions[0]).toBe(0.4);
    if (sampled) sampled.bones[5] = [0, 1, 0, 0];
    expect(buffer.sample(110)?.bones[5]).toEqual([0, 0, 0, 1]);
  });

  it("clears peer state explicitly and recovers from a long valid sender gap", () => {
    const buffer = new AvatarMotionBuffer();
    buffer.push(frame(1, 0), 0);
    expect(buffer.push(frame(2, 3000, 0.5), 3000)).toBe(true);
    expect(buffer.sample(3000)?.bones[5]?.[1]).toBeCloseTo(Math.sin(0.25));
    buffer.reset();
    expect(buffer.sample(3000)).toBeNull();
    expect(buffer.push(frame(0, 0), 3001)).toBe(true);
  });

  it("bounds retained snapshots even under sustained arrival and does not permit reverse-time rendering", () => {
    const buffer = new AvatarMotionBuffer(0);
    for (let index = 0; index < 1000; index += 1) {
      const next = frame(index, index * 100);
      next.pose.expressions[0] = index / 1000;
      buffer.push(next, index * 100);
    }
    expect(buffer.sample(0)?.expressions[0]).toBe(0.968);
    expect(buffer.sample(99_900)?.expressions[0]).toBe(0.999);
    expect(buffer.sample(99_000)?.expressions[0]).toBe(0.999);
  });
});

describe("native call avatar asset boundary", () => {
  it("uses only this app's selected local or bundled assets", () => {
    expect(
      isLocalCallAvatarUrl("asset://localhost/Users/me/avatar.vrm", "tauri://localhost/index.html"),
    ).toBe(true);
    expect(
      isLocalCallAvatarUrl(
        "http://asset.localhost/Users/me/avatar.vrm",
        "tauri://localhost/index.html",
      ),
    ).toBe(true);
    expect(isLocalCallAvatarUrl("/avatar.vrm", "http://localhost:1420/index.html")).toBe(true);
    expect(
      isLocalCallAvatarUrl(
        "blob:http://localhost:1420/example",
        "http://localhost:1420/index.html",
      ),
    ).toBe(true);
  });

  it("rejects network peers' URLs, local services on other ports, credentials, and executable schemes", () => {
    for (const url of [
      "https://peer.example/avatar.vrm",
      "//peer.example/avatar.vrm",
      "http://localhost:9000/avatar.vrm",
      "https://asset.localhost.evil/avatar.vrm",
      "asset://other/avatar.vrm",
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///Users/me/avatar.vrm",
      "http://user:pass@asset.localhost/a.vrm",
      "blob:https://peer.example/test",
    ]) {
      expect(isLocalCallAvatarUrl(url, "http://localhost:1420/index.html")).toBe(false);
    }
  });
});

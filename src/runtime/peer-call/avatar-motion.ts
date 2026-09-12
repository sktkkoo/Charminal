import type { VRM, VRMHumanBoneName, VRMPose } from "@pixiv/three-vrm";
import { Quaternion } from "three";

/** This order is part of the version 1 wire format; never derive it from a model. */
export const AVATAR_MOTION_BONES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftEye",
  "rightEye",
  "jaw",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftThumbMetacarpal",
  "leftThumbProximal",
  "leftThumbDistal",
  "leftIndexProximal",
  "leftIndexIntermediate",
  "leftIndexDistal",
  "leftMiddleProximal",
  "leftMiddleIntermediate",
  "leftMiddleDistal",
  "leftRingProximal",
  "leftRingIntermediate",
  "leftRingDistal",
  "leftLittleProximal",
  "leftLittleIntermediate",
  "leftLittleDistal",
  "rightThumbMetacarpal",
  "rightThumbProximal",
  "rightThumbDistal",
  "rightIndexProximal",
  "rightIndexIntermediate",
  "rightIndexDistal",
  "rightMiddleProximal",
  "rightMiddleIntermediate",
  "rightMiddleDistal",
  "rightRingProximal",
  "rightRingIntermediate",
  "rightRingDistal",
  "rightLittleProximal",
  "rightLittleIntermediate",
  "rightLittleDistal",
] as const satisfies ReadonlyArray<VRMHumanBoneName>;

/** Fixed facial vocabulary: peer-supplied expression names and mouth visemes are forbidden. */
export const AVATAR_MOTION_EXPRESSIONS = [
  "happy",
  "angry",
  "sad",
  "relaxed",
  "surprised",
  "neutral",
  "blink",
  "blinkLeft",
  "blinkRight",
  "Fcl_ALL_Joy",
  "Fcl_BRW_Angry",
  "Fcl_BRW_Joy",
  "Fcl_BRW_Sorrow",
  "Fcl_BRW_Surprised",
  "Fcl_EYE_Close_L",
  "Fcl_EYE_Close_R",
  "Fcl_EYE_Joy",
  "Fcl_EYE_Joy_L",
  "Fcl_EYE_Joy_R",
  "Fcl_EYE_Sorrow",
  "Fcl_EYE_Spread",
  "Fcl_MTH_Angry",
  "Fcl_MTH_Down",
  "Fcl_MTH_Joy",
  "Fcl_MTH_Sorrow",
  "Fcl_MTH_Up",
] as const;

export type AvatarQuaternion = [number, number, number, number];
export type AvatarPosition = [number, number, number];

export interface AvatarMotionPose {
  /** Rest-relative rotations in canonical VRM 1 coordinates; absent optional bones are null. */
  bones: Array<AvatarQuaternion | null>;
  /** Hips displacement from the model's own rest position, in metres. */
  hips: AvatarPosition;
  /** Scene translation (including breathing), never another participant's stage coordinates. */
  root: AvatarPosition;
  /** VRMLookAt yaw and pitch in degrees. */
  gaze: [number, number];
  expressions: number[];
}

export interface AvatarMotionFrame {
  sequence: number;
  timestampMs: number;
  pose: AvatarMotionPose;
}

export const AVATAR_MOTION_INTERVAL_MS = 100;
const MAGIC = 0x4159;
const VERSION = 1;
const MASK_BYTES = Math.ceil(AVATAR_MOTION_BONES.length / 8);
const POSE_OFFSET = 16 + MASK_BYTES;
const BONES_OFFSET = POSE_OFFSET + 16;
const EXPRESSIONS_OFFSET = BONES_OFFSET + AVATAR_MOTION_BONES.length * 8;
/** 16-byte header, 7-byte presence mask, 16-byte positions/gaze, 440-byte rotations, 26 expressions. */
export const AVATAR_MOTION_PACKET_BYTES = EXPRESSIONS_OFFSET + AVATAR_MOTION_EXPRESSIONS.length;
const MAX_FRAMES = 32;
const RESET_GAP_MS = 2_000;
const MAX_INTERPOLATION_GAP_MS = 500;

function within(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function validTime(value: number): boolean {
  return within(value, 0, Number.MAX_SAFE_INTEGER);
}

function validQuaternion(value: AvatarQuaternion): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((component) => within(component, -1, 1)) &&
    Math.abs(Math.hypot(...value) - 1) < 0.002
  );
}

function validPose(pose: AvatarMotionPose): boolean {
  return !!(
    pose &&
    Array.isArray(pose.bones) &&
    pose.bones.length === AVATAR_MOTION_BONES.length &&
    pose.bones.every((rotation) => rotation === null || validQuaternion(rotation)) &&
    [pose.hips, pose.root].every(
      (position) =>
        Array.isArray(position) &&
        position.length === 3 &&
        position.every((component) => within(component, -2, 2)),
    ) &&
    Array.isArray(pose.gaze) &&
    pose.gaze.length === 2 &&
    pose.gaze.every((angle) => within(angle, -90, 90)) &&
    Array.isArray(pose.expressions) &&
    pose.expressions.length === AVATAR_MOTION_EXPRESSIONS.length &&
    pose.expressions.every((weight) => within(weight, 0, 1))
  );
}

function validFrame(frame: AvatarMotionFrame): boolean {
  return (
    !!frame &&
    Number.isInteger(frame.sequence) &&
    within(frame.sequence, 0, 0xffffffff) &&
    validTime(frame.timestampMs) &&
    validPose(frame.pose)
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new RangeError("Avatar motion values must be finite");
  return Math.min(max, Math.max(min, value));
}

/** VRM 0 faces the opposite local direction; express both generations in one coordinate frame. */
function canonicalRotation(rotation: readonly number[], vrm0: boolean): AvatarQuaternion {
  const length = Math.hypot(...rotation);
  if (!Number.isFinite(length) || length < 0.0001) {
    throw new RangeError("Avatar motion needs a nonzero quaternion");
  }
  const sign = vrm0 ? -1 : 1;
  return [
    (rotation[0] * sign) / length,
    rotation[1] / length,
    (rotation[2] * sign) / length,
    rotation[3] / length,
  ];
}

/** Snapshot the resident's final Body/VRMA pose. This never mutates or retains its VRM nodes. */
export function captureAvatarMotion(
  vrm: VRM,
  sequence: number,
  timestampMs: number,
): AvatarMotionFrame {
  const pose = vrm.humanoid.getNormalizedPose();
  const vrm0 = vrm.meta.metaVersion === "0";
  const sign = vrm0 ? -1 : 1;
  const hips = pose.hips?.position ?? [0, 0, 0];
  const frame: AvatarMotionFrame = {
    sequence,
    timestampMs,
    pose: {
      bones: AVATAR_MOTION_BONES.map((name) => {
        const rotation = pose[name]?.rotation;
        return rotation ? canonicalRotation(rotation, vrm0) : null;
      }),
      hips: [clamp(hips[0] * sign, -2, 2), clamp(hips[1], -2, 2), clamp(hips[2] * sign, -2, 2)],
      root: [
        clamp(vrm.scene.position.x, -2, 2),
        clamp(vrm.scene.position.y, -2, 2),
        clamp(vrm.scene.position.z, -2, 2),
      ],
      gaze: [clamp(vrm.lookAt?.yaw ?? 0, -90, 90), clamp(vrm.lookAt?.pitch ?? 0, -90, 90)],
      expressions: AVATAR_MOTION_EXPRESSIONS.map((name) =>
        clamp(vrm.expressionManager?.getValue(name) ?? 0, 0, 1),
      ),
    },
  };
  if (!validFrame(frame)) throw new RangeError("Invalid avatar motion frame");
  return frame;
}

/** Every packet is a complete snapshot, so dropped unreliable packets require no delta recovery. */
export function encodeAvatarMotion(frame: AvatarMotionFrame): ArrayBuffer {
  if (!validFrame(frame)) throw new RangeError("Invalid avatar motion frame");
  const bytes = new ArrayBuffer(AVATAR_MOTION_PACKET_BYTES);
  const view = new DataView(bytes);
  view.setUint16(0, MAGIC, true);
  view.setUint8(2, VERSION);
  view.setUint32(4, frame.sequence, true);
  view.setFloat64(8, frame.timestampMs, true);
  [...frame.pose.hips, ...frame.pose.root].forEach((value, index) => {
    view.setInt16(POSE_OFFSET + index * 2, Math.round(value * 10_000), true);
  });
  frame.pose.gaze.forEach((value, index) => {
    view.setInt16(POSE_OFFSET + 12 + index * 2, Math.round(value * 100), true);
  });
  frame.pose.bones.forEach((rotation, index) => {
    if (rotation === null) return;
    const maskOffset = 16 + Math.floor(index / 8);
    view.setUint8(maskOffset, view.getUint8(maskOffset) | (1 << (index % 8)));
    rotation.forEach((value, component) => {
      view.setInt16(BONES_OFFSET + index * 8 + component * 2, Math.round(value * 32767), true);
    });
  });
  frame.pose.expressions.forEach((weight, index) => {
    view.setUint8(EXPRESSIONS_OFFSET + index, Math.round(weight * 255));
  });
  return bytes;
}

/** Reject unknown versions, malformed masks, impossible rotations and excess bytes before rendering. */
export function decodeAvatarMotion(bytes: ArrayBuffer): AvatarMotionFrame | null {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== AVATAR_MOTION_PACKET_BYTES)
    return null;
  const view = new DataView(bytes);
  const lastMaskBits = AVATAR_MOTION_BONES.length % 8;
  if (
    view.getUint16(0, true) !== MAGIC ||
    view.getUint8(2) !== VERSION ||
    view.getUint8(3) !== 0 ||
    (lastMaskBits !== 0 && view.getUint8(16 + MASK_BYTES - 1) >> lastMaskBits !== 0)
  )
    return null;
  const bones: AvatarMotionPose["bones"] = [];
  for (let index = 0; index < AVATAR_MOTION_BONES.length; index += 1) {
    const present = (view.getUint8(16 + Math.floor(index / 8)) & (1 << (index % 8))) !== 0;
    const rotation: AvatarQuaternion = [0, 0, 0, 0];
    for (let component = 0; component < 4; component += 1) {
      rotation[component] = view.getInt16(BONES_OFFSET + index * 8 + component * 2, true) / 32767;
    }
    if (!present && rotation.some((component) => component !== 0)) return null;
    if (present && !validQuaternion(rotation)) return null;
    bones.push(present ? canonicalRotation(rotation, false) : null);
  }
  const position = (offset: number): AvatarPosition => [
    view.getInt16(offset, true) / 10_000,
    view.getInt16(offset + 2, true) / 10_000,
    view.getInt16(offset + 4, true) / 10_000,
  ];
  const frame: AvatarMotionFrame = {
    sequence: view.getUint32(4, true),
    timestampMs: view.getFloat64(8, true),
    pose: {
      bones,
      hips: position(POSE_OFFSET),
      root: position(POSE_OFFSET + 6),
      gaze: [
        view.getInt16(POSE_OFFSET + 12, true) / 100,
        view.getInt16(POSE_OFFSET + 14, true) / 100,
      ],
      expressions: AVATAR_MOTION_EXPRESSIONS.map(
        (_, index) => view.getUint8(EXPRESSIONS_OFFSET + index) / 255,
      ),
    },
  };
  return validFrame(frame) ? frame : null;
}

/** Convert canonical network rotations to a receiver's own normalized skeleton, preserving its proportions. */
export function avatarMotionVrmPose(pose: AvatarMotionPose, vrm0: boolean): VRMPose {
  const result: VRMPose = {};
  AVATAR_MOTION_BONES.forEach((name, index) => {
    const rotation = pose.bones[index];
    if (rotation) result[name] = { rotation: canonicalRotation(rotation, vrm0) };
  });
  const sign = vrm0 ? -1 : 1;
  result.hips = {
    ...result.hips,
    position: [pose.hips[0] * sign, pose.hips[1], pose.hips[2] * sign],
  };
  return result;
}

function copyPose(pose: AvatarMotionPose): AvatarMotionPose {
  return {
    bones: pose.bones.map((rotation) => (rotation ? [...rotation] : null)),
    hips: [...pose.hips],
    root: [...pose.root],
    gaze: [...pose.gaze],
    expressions: [...pose.expressions],
  };
}

function newer(sequence: number, previous: number): boolean {
  const distance = (sequence - previous) >>> 0;
  return distance > 0 && distance < 0x80000000;
}

function interpolate(
  before: AvatarMotionPose,
  after: AvatarMotionPose,
  amount: number,
): AvatarMotionPose {
  const scalar = (a: number, b: number) => a + (b - a) * amount;
  const position = (a: AvatarPosition, b: AvatarPosition): AvatarPosition => [
    scalar(a[0], b[0]),
    scalar(a[1], b[1]),
    scalar(a[2], b[2]),
  ];
  const a = new Quaternion();
  const b = new Quaternion();
  return {
    bones: before.bones.map((rotation, index) => {
      const next = after.bones[index];
      if (!rotation || !next) return rotation ? [...rotation] : null;
      return a.fromArray(rotation).slerp(b.fromArray(next), amount).toArray();
    }),
    hips: position(before.hips, after.hips),
    root: position(before.root, after.root),
    gaze: [scalar(before.gaze[0], after.gaze[0]), scalar(before.gaze[1], after.gaze[1])],
    expressions: before.expressions.map((weight, index) =>
      scalar(weight, after.expressions[index]),
    ),
  };
}

/**
 * Small receiver-owned motion buffer. Uses arrival/send clock offset estimates, not audio timestamps.
 * No unbounded queue, extrapolation, animation generation, or ownership of the resident's VRM.
 */
export class AvatarMotionBuffer {
  private frames: AvatarMotionFrame[] = [];
  private offsets: number[] = [];
  private latestArrival = 0;
  private lastArrival = 0;
  private lastTarget: number | null = null;

  constructor(private readonly delayMs = 100) {
    if (!within(delayMs, 0, 1_000)) throw new RangeError("Invalid avatar motion buffer delay");
  }

  push(frame: AvatarMotionFrame, receivedAtMs: number): boolean {
    if (!validFrame(frame) || !validTime(receivedAtMs)) return false;
    let latest: AvatarMotionFrame | undefined = this.frames[this.frames.length - 1];
    if (latest && receivedAtMs < this.lastArrival) return false;
    const advances = !latest || newer(frame.sequence, latest.sequence);
    if (latest) {
      if (this.frames.some((existing) => existing.sequence === frame.sequence)) return false;
      const gap = frame.timestampMs - latest.timestampMs;
      const arrivalGap = receivedAtMs - this.latestArrival;
      if (advances) {
        if (gap <= 0 || gap > arrivalGap + RESET_GAP_MS) return false;
        if (gap >= RESET_GAP_MS || arrivalGap >= RESET_GAP_MS) {
          this.reset();
          latest = undefined;
        }
      } else if (
        gap >= 0 ||
        -gap >= RESET_GAP_MS ||
        arrivalGap >= RESET_GAP_MS ||
        (latest.sequence - frame.sequence) >>> 0 >= MAX_FRAMES
      ) {
        return false;
      }
    }
    const found = this.frames.findIndex((existing) => existing.timestampMs >= frame.timestampMs);
    const index = found < 0 ? this.frames.length : found;
    const before = this.frames[index - 1];
    const after = this.frames[index];
    if (
      (before && !newer(frame.sequence, before.sequence)) ||
      (after && (after.timestampMs === frame.timestampMs || !newer(after.sequence, frame.sequence)))
    )
      return false;
    this.frames.splice(index, 0, { ...frame, pose: copyPose(frame.pose) });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
    this.lastArrival = receivedAtMs;
    if (advances || !latest) {
      this.latestArrival = receivedAtMs;
      this.offsets.push(receivedAtMs - frame.timestampMs);
      if (this.offsets.length > MAX_FRAMES) this.offsets.shift();
    }
    return true;
  }

  sample(nowMs: number): AvatarMotionPose | null {
    if (!validTime(nowMs) || this.frames.length === 0 || nowMs - this.latestArrival > RESET_GAP_MS)
      return null;
    const target = Math.max(
      this.lastTarget ?? -Infinity,
      nowMs - Math.min(...this.offsets) - this.delayMs,
    );
    this.lastTarget = target;
    const first = this.frames[0];
    if (target <= first.timestampMs) return copyPose(first.pose);
    for (let index = 1; index < this.frames.length; index += 1) {
      const after = this.frames[index];
      if (target < after.timestampMs) {
        const before = this.frames[index - 1];
        const gap = after.timestampMs - before.timestampMs;
        if (gap > MAX_INTERPOLATION_GAP_MS) return copyPose(before.pose);
        return interpolate(before.pose, after.pose, (target - before.timestampMs) / gap);
      }
    }
    return copyPose(this.frames[this.frames.length - 1].pose);
  }

  reset(): void {
    this.frames = [];
    this.offsets = [];
    this.latestArrival = 0;
    this.lastArrival = 0;
    this.lastTarget = null;
  }
}

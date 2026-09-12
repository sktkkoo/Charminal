import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { registerOrphanMorphs } from "../../core/body/register-orphan-morphs";
import { applyVrmRestPose } from "../../core/body/vrm-rest-pose";
import { MOUTH_KEYS, type MouthValues } from "../../core/voice/mouth-values";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import type { ThreeRuntime } from "../three-runtime/types";
import { getVrmCache } from "../vrm-cache";
import {
  AVATAR_MOTION_EXPRESSIONS,
  type AvatarMotionPose,
  avatarMotionVrmPose,
} from "./avatar-motion";
import { validateAvatarGlb } from "./avatar-transfer";
import { isIssuedCallAvatarUrl } from "./call-avatar-url";

export interface TheaterCallPeerSource {
  /** A registered blob created by this room's validated avatar transfer. Never a peer URL. */
  readonly avatarUrl: string;
  readonly sampleMotion: () => AvatarMotionPose | null;
  readonly sampleMouth: () => Readonly<MouthValues> | number;
  readonly onState?: (state: "loading" | "ready" | "error", message?: string) => void;
}

type TheaterRuntime = Pick<ThreeRuntime, "getScene" | "getCamera" | "getVrm" | "subscribeFrame">;

interface LocalPlacement {
  readonly vrm: VRM;
  readonly parent: THREE.Object3D;
  readonly childIndex: number;
  readonly group: THREE.Group;
}

function unit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function isTransferredAvatarUrl(value: string): boolean {
  return isIssuedCallAvatarUrl(value);
}

/** Keep both heads within the current view without changing the user's camera or zoom. */
export function theaterCallSpacing(
  distance: number,
  aspect: number,
  fov: number,
  zoom = 1,
): number {
  if (
    ![distance, aspect, fov, zoom].every(Number.isFinite) ||
    distance <= 0 ||
    aspect <= 0 ||
    zoom <= 0
  )
    return 0;
  const halfWidth =
    (distance * Math.tan(THREE.MathUtils.degToRad(Math.max(1, Math.min(179, fov)) / 2)) * aspect) /
    zoom;
  return Math.min(0.5, halfWidth * 0.52);
}

/**
 * A single remote resident inside the actual main scene. The local Body remains the same
 * object with the same root transform, bones and expressions. Placement is a temporary
 * parent so local stage coordinates cannot enter the transmitted motion snapshot.
 * Dispose when leaving theater, changing peer/avatar, or leaving the call.
 */
export function attachTheaterCallPeer(
  source: TheaterCallPeerSource,
  runtime: TheaterRuntime = getThreeRuntime(),
): { dispose(): void } {
  const scene = runtime.getScene();
  const remotePlacement = new THREE.Group();
  remotePlacement.name = "yorishiro-call-peer-placement";
  let disposed = false;
  let remote: VRM | null = null;
  let restPose: ReturnType<VRM["humanoid"]["getNormalizedPose"]> | null = null;
  let local: LocalPlacement | null = null;
  const anchor = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const cameraRotation = new THREE.Quaternion();
  const parentInverse = new THREE.Matrix3();

  const releaseLocal = () => {
    if (!local) return;
    // Another subsystem may already have replaced or reparented the resident. Do not
    // resurrect a disposed model or overwrite that subsystem's new ownership.
    if (local.vrm.scene.parent === local.group) {
      if (runtime.getVrm() === local.vrm) {
        local.parent.add(local.vrm.scene);
        const index = local.parent.children.indexOf(local.vrm.scene);
        local.parent.children.splice(index, 1);
        local.parent.children.splice(
          Math.min(local.childIndex, local.parent.children.length),
          0,
          local.vrm.scene,
        );
      } else {
        local.vrm.scene.removeFromParent();
      }
    }
    local.group.removeFromParent();
    local = null;
  };

  const placeLocal = () => {
    const current = runtime.getVrm();
    if (local?.vrm === current && current?.scene.parent === local.group) return;
    releaseLocal();
    if (!current?.scene.parent) {
      remotePlacement.visible = false;
      return;
    }
    const parent = current.scene.parent;
    const childIndex = parent.children.indexOf(current.scene);
    const group = new THREE.Group();
    group.name = "yorishiro-call-local-placement";
    parent.add(group);
    group.add(current.scene);
    local = { vrm: current, parent, childIndex, group };
    parent.add(remotePlacement);
    remotePlacement.visible = true;
  };

  const spaceResidents = () => {
    if (!local) return;
    const camera = runtime.getCamera();
    const bone = local.vrm.humanoid.getNormalizedBoneNode("head");
    (bone ?? local.vrm.scene).getWorldPosition(anchor);
    camera.getWorldPosition(cameraPosition);
    camera.getWorldDirection(forward);
    const distance = anchor.sub(cameraPosition).dot(forward);
    const spacing = theaterCallSpacing(distance, camera.aspect, camera.fov, camera.zoom);
    camera.getWorldQuaternion(cameraRotation);
    offset.set(1, 0, 0).applyQuaternion(cameraRotation);
    // Preserve the ground plane even when the user tilts or rolls their camera.
    offset.y = 0;
    if (offset.lengthSq() < 1e-8) offset.set(1, 0, 0);
    offset.normalize().multiplyScalar(spacing);
    local.parent.updateWorldMatrix(true, false);
    parentInverse.setFromMatrix4(local.parent.matrixWorld).invert();
    offset.applyMatrix3(parentInverse);
    local.group.position.copy(offset).negate();
    remotePlacement.position.copy(offset);
  };

  const unsubscribe = runtime.subscribeFrame((delta) => {
    if (disposed || !remote || !restPose) return;
    if (!isTransferredAvatarUrl(source.avatarUrl)) {
      dispose();
      return;
    }
    placeLocal();
    spaceResidents();
    const pose = source.sampleMotion();
    remote.humanoid.setNormalizedPose(restPose);
    if (pose) {
      remote.humanoid.setNormalizedPose(avatarMotionVrmPose(pose, remote.meta.metaVersion === "0"));
      remote.scene.position.fromArray(pose.root);
    } else remote.scene.position.set(0, 0, 0);
    if (remote.lookAt) {
      remote.lookAt.yaw = pose?.gaze[0] ?? 0;
      remote.lookAt.pitch = pose?.gaze[1] ?? 0;
    }
    AVATAR_MOTION_EXPRESSIONS.forEach((name, index) => {
      remote?.expressionManager?.setValue(name, pose?.expressions[index] ?? 0);
    });
    const mouth = source.sampleMouth();
    for (const key of MOUTH_KEYS) {
      const value = typeof mouth === "number" ? (key === "aa" ? mouth : 0) : mouth[key];
      remote.expressionManager?.setValue(key, unit(value));
    }
    remote.update(Math.min(0.1, Math.max(0, delta)));
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    releaseLocal();
    remotePlacement.removeFromParent();
    if (remote) {
      VRMUtils.deepDispose(remote.scene);
      remote = null;
    }
    restPose = null;
  };

  source.onState?.("loading");
  void (async () => {
    let parsed: THREE.Group | null = null;
    try {
      if (!isTransferredAvatarUrl(source.avatarUrl))
        throw new Error("Theater peer avatars must come from this call's transfer");
      const bytes = await getVrmCache().getBytes(source.avatarUrl);
      if (disposed) return;
      if (!isTransferredAvatarUrl(source.avatarUrl)) {
        dispose();
        return;
      }
      if (!validateAvatarGlb(bytes)) throw new Error("Invalid transferred VRM");
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        // The GLB preflight forbids URIs, so only loader-created embedded image blobs
        // should ever reach this manager. No fetching peer-controlled resources.
        // Only internal GLB image blobs reach this manager after URI-free preflight.
        // They are minted by GLTFLoader, not by the call-avatar registry, and may have
        // an opaque native origin. No metadata URI or peer URL can reach this path.
        if (url.startsWith("blob:")) return url;
        throw new Error("External avatar resources are not supported");
      });
      const loader = new GLTFLoader(manager);
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.parseAsync(bytes, "");
      parsed = gltf.scene;
      if (disposed || !isTransferredAvatarUrl(source.avatarUrl)) {
        VRMUtils.deepDispose(parsed);
        dispose();
        return;
      }
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm?.humanoid) throw new Error("No humanoid VRM found");
      VRMUtils.rotateVRM0(vrm);
      applyVrmRestPose(vrm);
      registerOrphanMorphs(vrm);
      if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
      vrm.update(0);
      restPose = vrm.humanoid.getNormalizedPose();
      remotePlacement.add(vrm.scene);
      scene.add(remotePlacement);
      remote = vrm;
      placeLocal();
      spaceResidents();
      source.onState?.("ready");
    } catch {
      if (parsed && !remote) VRMUtils.deepDispose(parsed);
      if (!disposed) {
        dispose();
        source.onState?.("error", "相手のアバターを表示できませんでした。");
      }
    }
  })();

  return { dispose };
}

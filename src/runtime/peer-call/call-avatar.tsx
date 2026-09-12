import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { registerOrphanMorphs } from "../../core/body/register-orphan-morphs";
import { applyVrmRestPose } from "../../core/body/vrm-rest-pose";
import { MOUTH_KEYS, type MouthValues } from "../../core/voice/mouth-values";
import { getVrmCache } from "../vrm-cache";
import {
  AVATAR_MOTION_EXPRESSIONS,
  type AvatarMotionPose,
  avatarMotionVrmPose,
} from "./avatar-motion";
import { validateAvatarGlb } from "./avatar-transfer";
import type { RemoteCallCamera } from "./remote-call-window";

export interface NativeCallAvatarProps {
  /** Trusted URL from this installation's avatar picker. Never use a value supplied by the peer. */
  avatarUrl: string;
  /** Native lease-provided bytes. Parse a clone, without assuming opaque-origin Blob URL fetchability. */
  avatarBytes?: ArrayBuffer;
  label: string;
  sampleMotion: () => AvatarMotionPose | null;
  /** Derived from the received audio playback path. A number means amplitude-only openness. */
  sampleMouth?: () => Readonly<MouthValues> | number;
  /** Detached native participants inherit the main view's existing camera, never a new preset. */
  sampleCamera?: () => RemoteCallCamera | null;
  className?: string;
}

/** Only app-local assets can be used as a call participant's representation. */
export function isLocalCallAvatarUrl(value: string, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.username || url.password) return false;
    if (url.protocol === "asset:" && url.hostname === "localhost") return true;
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname === "asset.localhost" &&
      !url.port
    )
      return true;
    if (url.protocol === "blob:") {
      return base.origin !== "null" && url.origin === base.origin;
    }
    return (
      ["http:", "https:", "tauri:"].includes(url.protocol) &&
      url.protocol === base.protocol &&
      url.host === base.host
    );
  } catch {
    return false;
  }
}

function unit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/**
 * Owns a separate VRM instance and renderer; never reparents, disposes, or drives the resident.
 * This renderer has no Body, persona pack, local idle generator, microphone, or audio output.
 */
function NativeCallCanvas({
  participants,
  className,
}: {
  participants: NativeCallAvatarProps[];
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samples = useRef(participants);
  samples.current = participants;
  const [loadState, setLoadState] = useState("姿を読み込んでいます…");
  const [error, setError] = useState<string | null>(null);
  // Keep the WebGL/VRM lifecycle independent of callback identity and every-frame UI state.
  const assetKey = JSON.stringify(participants.map((participant) => participant.avatarUrl));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setError(null);
    setLoadState("姿を読み込んでいます…");
    const avatarUrls = JSON.parse(assetKey) as string[];
    const avatarBytes = samples.current.map((participant) => participant.avatarBytes);
    const count = avatarUrls.length;
    if (
      count < 1 ||
      count > 4 ||
      avatarUrls.some((url, index) =>
        avatarBytes[index]
          ? !validateAvatarGlb(avatarBytes[index])
          : !isLocalCallAvatarUrl(url, window.location.href),
      )
    ) {
      setError("この端末に保存したアバターを選んでください。");
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      setError("アバターの表示を開始できませんでした。");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe4f3ff, 0x30343d, 2));
    const light = new THREE.DirectionalLight(0xfff4e8, 2);
    light.position.set(1, 2, 3);
    scene.add(light);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 20);
    let tallestHead = 1.5;
    const headHeights = Array.from({ length: count }, () => 0);
    const frameCamera = () => {
      const targetY = count > 1 ? tallestHead * 0.58 : Math.max(0.2, tallestHead - 0.17);
      const width = count > 1 ? count * 1.15 : 0.65;
      const height = count > 1 ? tallestHead * 1.2 : tallestHead * 0.65;
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const distance = Math.max(height / (2 * tangent), width / (2 * tangent * camera.aspect));
      camera.position.set(0, targetY, Math.max(0.9, distance));
      camera.lookAt(0, targetY, 0);
    };
    frameCamera();
    let disposed = false;
    let animation = 0;
    const avatars: Array<{
      vrm: VRM;
      restPose: ReturnType<VRM["humanoid"]["getNormalizedPose"]>;
      placement: THREE.Group;
    } | null> = Array.from({ length: count }, () => null);
    let previousTime = performance.now();
    const head = new THREE.Vector3();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
      frameCamera();
      renderer.render(scene, camera);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      // GLB-embedded textures/buffers are sufficient. An avatar cannot use this renderer
      // to introduce external HTTP requests, even if a local file contains external URIs.
      if (url.startsWith("blob:") || /^data:(image\/|application\/octet-stream[;,])/i.test(url))
        return url;
      throw new Error("Call avatars must contain embedded resources");
    });
    const loader = new GLTFLoader(manager);
    loader.register((parser) => new VRMLoaderPlugin(parser));
    void Promise.all(
      avatarUrls.map(async (avatarUrl, index) => {
        let parsedScene: THREE.Group | null = null;
        try {
          const bytes = avatarBytes[index]?.slice(0) ?? (await getVrmCache().getBytes(avatarUrl));
          if (disposed) return;
          // Parse a fresh VRM from cached immutable bytes. Parsed skeletons are never shared.
          const gltf = await loader.parseAsync(bytes, "");
          parsedScene = gltf.scene;
          const loaded = gltf.userData.vrm as VRM | undefined;
          if (disposed) {
            VRMUtils.deepDispose(gltf.scene);
            return;
          }
          if (!loaded?.humanoid) {
            throw new Error("No humanoid VRM found");
          }
          VRMUtils.rotateVRM0(loaded);
          applyVrmRestPose(loaded);
          registerOrphanMorphs(loaded);
          if (loaded.lookAt) loaded.lookAt.autoUpdate = false;
          const placement = new THREE.Group();
          placement.position.x = (index - (count - 1) / 2) * 1.15;
          placement.add(loaded.scene);
          scene.add(placement);
          avatars[index] = {
            vrm: loaded,
            restPose: loaded.humanoid.getNormalizedPose(),
            placement,
          };
          loaded.update(0);
          loaded.scene.updateWorldMatrix(true, true);
          const headBone = loaded.humanoid.getNormalizedBoneNode("head");
          if (headBone) headBone.getWorldPosition(head);
          else head.set(0, 1.5, 0);
          headHeights[index] = head.y;
          tallestHead = Math.max(0.3, ...headHeights);
          frameCamera();
          previousTime = performance.now();
        } catch {
          const instance = avatars[index];
          if (instance) scene.remove(instance.placement);
          avatars[index] = null;
          if (parsedScene) VRMUtils.deepDispose(parsedScene);
          if (!disposed)
            setError("アバターを読み込めませんでした。ローカルのVRMを選び直してください。");
        }
      }),
    ).then(() => {
      if (!disposed) setLoadState("");
    });

    const render = (now: number) => {
      if (disposed) return;
      const delta = Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
      previousTime = now;
      avatars.forEach((instance, index) => {
        const source = samples.current[index];
        if (!instance || !source) return;
        const current = instance.vrm;
        const pose = source.sampleMotion();
        // Restore only this receiver's rest pose so absent optional bones cannot retain
        // the previous participant's pose across a source/model change.
        current.humanoid.setNormalizedPose(instance.restPose);
        if (pose) {
          current.humanoid.setNormalizedPose(
            avatarMotionVrmPose(pose, current.meta.metaVersion === "0"),
          );
          current.scene.position.fromArray(pose.root);
          if (current.lookAt) {
            current.lookAt.yaw = pose.gaze[0];
            current.lookAt.pitch = pose.gaze[1];
          }
        } else {
          current.scene.position.set(0, 0, 0);
          if (current.lookAt) {
            current.lookAt.yaw = 0;
            current.lookAt.pitch = 0;
          }
        }
        AVATAR_MOTION_EXPRESSIONS.forEach((name, index) => {
          current.expressionManager?.setValue(name, pose?.expressions[index] ?? 0);
        });
        const mouth = source.sampleMouth?.() ?? 0;
        for (const key of MOUTH_KEYS) {
          const weight = typeof mouth === "number" ? (key === "aa" ? mouth : 0) : mouth[key];
          current.expressionManager?.setValue(key, unit(weight));
        }
        current.update(delta);
      });
      const inheritedCamera = samples.current[0]?.sampleCamera?.();
      if (count === 1 && inheritedCamera) {
        camera.position.fromArray(inheritedCamera.position);
        // Keep the same framing for residents of different heights.
        camera.position.y += (headHeights[0] || inheritedCamera.anchorY) - inheritedCamera.anchorY;
        camera.quaternion.fromArray(inheritedCamera.quaternion);
        if (
          camera.fov !== inheritedCamera.fov ||
          camera.zoom !== (inheritedCamera.zoom ?? 1) ||
          camera.near !== inheritedCamera.near ||
          camera.far !== inheritedCamera.far
        ) {
          camera.fov = inheritedCamera.fov;
          camera.zoom = inheritedCamera.zoom ?? 1;
          camera.near = inheritedCamera.near;
          camera.far = inheritedCamera.far;
          camera.updateProjectionMatrix();
        }
      }
      renderer.render(scene, camera);
      animation = requestAnimationFrame(render);
    };
    animation = requestAnimationFrame(render);
    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
      observer.disconnect();
      avatars.forEach((instance, index) => {
        if (!instance) return;
        scene.remove(instance.placement);
        VRMUtils.deepDispose(instance.vrm.scene);
        avatars[index] = null;
      });
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, [assetKey]);

  return (
    <div className={className ?? "native-call-avatar"}>
      <canvas
        ref={canvasRef}
        aria-label={participants.map((participant) => participant.label).join(" / ")}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {error ? <p role="alert">{error}</p> : loadState ? <p role="status">{loadState}</p> : null}
    </div>
  );
}

export function NativeCallAvatar(props: NativeCallAvatarProps) {
  return <NativeCallCanvas participants={[props]} className={props.className} />;
}

export interface NativeCallStageProps {
  participants: NativeCallAvatarProps[];
  layout: "theater" | "call" | "portrait";
  className?: string;
}

/** Theater shares one scene; changing presentation never changes the underlying call or agents. */
export function NativeCallStage({ participants, layout, className }: NativeCallStageProps) {
  if (layout === "theater") {
    return (
      <div className={className ?? "native-call-stage native-call-stage-theater"}>
        <NativeCallCanvas participants={participants} />
        <div className="native-call-stage-labels">
          {participants.map((participant) => (
            <span key={participant.label}>{participant.label}</span>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={className ?? `native-call-stage native-call-stage-${layout}`}>
      {participants.map((participant) => (
        <figure className="native-call-participant" key={participant.label}>
          <NativeCallAvatar {...participant} />
          <figcaption>{participant.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

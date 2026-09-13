import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { registerOrphanMorphs } from "../../core/body/register-orphan-morphs";
import { applyVrmRestPose } from "../../core/body/vrm-rest-pose";
import { SceneRouter } from "../../core/scene/scene-router";
import { MOUTH_KEYS, type MouthValues } from "../../core/voice/mouth-values";
import type { ScenePackEntry } from "../scene-pack-registry";
import { R3fHost } from "../three-runtime/r3f-host";
import { getVrmCache } from "../vrm-cache";
import {
  AVATAR_MOTION_EXPRESSIONS,
  type AvatarMotionPose,
  avatarMotionVrmPose,
} from "./avatar-motion";
import { validateAvatarGlb } from "./avatar-transfer";
import { CallSceneRoot } from "./call-scene-root";
import type { CallSceneAppearance } from "./call-scene-state";
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
  /** Scene from this installation, resolved through the same pack loader as main. */
  sceneEntry?: ScenePackEntry | null;
  appearance?: CallSceneAppearance | null;
  /** Retain the loaded view while hidden; resume without recreating its VRM or scene. */
  active?: boolean;
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resizeViewport = useRef<(() => void) | null>(null);
  const setRendering = useRef<((active: boolean) => void) | null>(null);
  // SceneRouter may replace its character slot when the layer structure changes. Keep the
  // renderer/VRM above that lifecycle and move its existing canvas into the new slot, like main.
  const attachCanvas = useCallback((host: HTMLDivElement | null) => {
    canvasHostRef.current = host;
    if (host && activeCanvasRef.current) {
      host.appendChild(activeCanvasRef.current);
      resizeViewport.current?.();
    }
  }, []);
  const updateScene = useRef<
    ((entry?: ScenePackEntry | null, appearance?: CallSceneAppearance | null) => void) | null
  >(null);
  const sceneEntry = participants[0]?.sceneEntry;
  const appearance = participants[0]?.appearance;
  const active = participants[0]?.active !== false;
  const samples = useRef(participants);
  samples.current = participants;
  const [loadState, setLoadState] = useState("姿を読み込んでいます…");
  const [error, setError] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  // Keep the WebGL/VRM lifecycle independent of callback identity and every-frame UI state.
  const assetKey = JSON.stringify(participants.map((participant) => participant.avatarUrl));

  useEffect(() => {
    const canvasHost = canvasHostRef.current;
    const viewport = viewportRef.current;
    if (!canvasHost || !viewport) return;
    setError(null);
    setSceneError(null);
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
    // R3F/WebGL disposal is asynchronous. Never hand a new renderer a canvas whose
    // previous root is still tearing down during a model swap, StrictMode or HMR.
    const canvas = document.createElement("canvas");
    activeCanvasRef.current = canvas;
    canvas.setAttribute("aria-label", samples.current.map((p) => p.label).join(" / "));
    Object.assign(canvas.style, { width: "100%", height: "100%", display: "block" });
    canvasHost.appendChild(canvas);
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
    } catch {
      canvas.remove();
      if (activeCanvasRef.current === canvas) activeCanvasRef.current = null;
      setError("アバターの表示を開始できませんでした。");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    // Only the legacy isolated preview uses fallback lights. Native peer windows
    // load the actual selected scene, including its lighting/environment/composer.
    if (samples.current[0]?.appearance === undefined) {
      scene.add(new THREE.HemisphereLight(0xe4f3ff, 0x30343d, 2));
      const light = new THREE.DirectionalLight(0xfff4e8, 2);
      light.position.set(1, 2, 3);
      scene.add(light);
    }
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
    let sceneHost: R3fHost | null = null;
    const syncScene = (
      entry = samples.current[0]?.sceneEntry,
      appearance = samples.current[0]?.appearance,
    ) => {
      if (disposed || !sceneHost) return;
      sceneHost.render(
        entry ? (
          <CallSceneRoot
            key={`${entry.origin}:${entry.id}`}
            entry={entry}
            controls={appearance?.controls ?? {}}
            getAnchor={() => {
              const bone = avatars[0]?.vrm.humanoid.getNormalizedBoneNode("head");
              return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
            }}
            onError={() => {
              const current = samples.current[0]?.sceneEntry;
              if (
                !disposed &&
                current?.id === entry.id &&
                current.origin === entry.origin &&
                current.component === entry.component
              ) {
                setSceneError("シーンを表示できませんでした。");
              }
            }}
          />
        ) : null,
      );
    };
    updateScene.current = syncScene;

    const resize = () => {
      // R3F may set canvas.style to fixed pixels while configuring its renderer.
      // Measure the surrounding view instead so a sidebar resize cannot remain
      // trapped at the canvas's initial/intrinsic 300 x 150 dimensions.
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
      frameCamera();
      sceneHost?.setSize(rect.width, rect.height);
      Object.assign(canvas.style, { width: "100%", height: "100%" });
    };
    resizeViewport.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    resize();
    if (samples.current[0]?.appearance !== undefined) {
      sceneHost = new R3fHost({ canvas, renderer, scene, camera });
      void sceneHost
        .initialize()
        .then(() => {
          if (!disposed) {
            syncScene();
            resize();
          }
        })
        .catch(() => {
          if (!disposed) setSceneError("シーンの表示を開始できませんでした。");
        });
    }

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
      animation = 0;
      if (disposed || samples.current[0]?.active === false) return;
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
        const headBone = avatars[0]?.vrm.humanoid.getNormalizedBoneNode("head");
        if (headBone) {
          // Main's anchor includes its current pose and world transform. Compare the peer in
          // that same coordinate space after applying this frame's motion, not its load-time
          // rest height. This preserves the selected camera's offset, including X/Z, without
          // moving/rescaling the avatar or adding a second view-mode camera preset.
          headBone.getWorldPosition(head);
          if (inheritedCamera.anchor) {
            camera.position.x += head.x - inheritedCamera.anchor[0];
            camera.position.y += head.y - inheritedCamera.anchor[1];
            camera.position.z += head.z - inheritedCamera.anchor[2];
          } else {
            camera.position.y += head.y - inheritedCamera.anchorY;
          }
        }
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
      const visual = samples.current[0]?.appearance?.renderer;
      if (visual) {
        renderer.toneMapping = visual.toneMapping as THREE.ToneMapping;
        renderer.toneMappingExposure = visual.toneMappingExposure;
        renderer.outputColorSpace = visual.outputColorSpace;
        renderer.shadowMap.enabled = visual.shadowMapEnabled;
        renderer.shadowMap.type = visual.shadowMapType as THREE.ShadowMapType;
      }
      // R3F owns useFrame and postprocessing priority; rendering again here would
      // overwrite the scene's EffectComposer output with the raw unlit result.
      if (!sceneHost?.advance(now)) renderer.render(scene, camera);
      animation = requestAnimationFrame(render);
    };
    const toggleRendering = (active: boolean) => {
      if (disposed) return;
      if (!active) {
        cancelAnimationFrame(animation);
        animation = 0;
      } else if (!animation) {
        previousTime = performance.now();
        resize();
        animation = requestAnimationFrame(render);
      }
    };
    setRendering.current = toggleRendering;
    toggleRendering(samples.current[0]?.active !== false);
    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
      observer.disconnect();
      if (resizeViewport.current === resize) resizeViewport.current = null;
      if (setRendering.current === toggleRendering) setRendering.current = null;
      if (updateScene.current === syncScene) updateScene.current = null;
      sceneHost?.dispose();
      avatars.forEach((instance, index) => {
        if (!instance) return;
        scene.remove(instance.placement);
        VRMUtils.deepDispose(instance.vrm.scene);
        avatars[index] = null;
      });
      // R3F unmount owns renderer disposal when present.
      if (!sceneHost) {
        renderer.dispose();
        renderer.forceContextLoss();
      }
      canvas.remove();
      if (activeCanvasRef.current === canvas) activeCanvasRef.current = null;
    };
  }, [assetKey]);
  useEffect(() => {
    setRendering.current?.(active);
  }, [active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new scene identity can recover a failed component boundary.
  useEffect(() => {
    setSceneError(null);
  }, [sceneEntry?.origin, sceneEntry?.id, sceneEntry?.component]);
  useEffect(() => {
    updateScene.current?.(sceneEntry, appearance);
  }, [sceneEntry, appearance]);

  const renderedEntry =
    sceneEntry && appearance?.scene ? { ...sceneEntry, scene: appearance.scene } : sceneEntry;
  return (
    <div
      ref={viewportRef}
      className={className ?? "native-call-avatar"}
      style={{ width: "100%", height: "100%" }}
    >
      <SceneRouter entry={renderedEntry ?? null}>
        <div ref={attachCanvas} style={{ width: "100%", height: "100%", display: "block" }} />
      </SceneRouter>
      {error || sceneError ? (
        <p role="alert">{error || sceneError}</p>
      ) : loadState ? (
        <p role="status">{loadState}</p>
      ) : null}
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

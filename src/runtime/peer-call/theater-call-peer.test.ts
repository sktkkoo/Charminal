// @vitest-environment jsdom

import type { VRM } from "@pixiv/three-vrm";
import {
  BoxGeometry,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_MOTION_BONES,
  AVATAR_MOTION_EXPRESSIONS,
  type AvatarMotionPose,
} from "./avatar-motion";
import { createCallAvatarUrl, revokeCallAvatarUrl } from "./call-avatar-url";
import {
  attachTheaterCallPeer,
  isTransferredAvatarUrl,
  theaterCallSpacing,
} from "./theater-call-peer";

const mock = vi.hoisted(() => ({
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
  getBytes: vi.fn(),
  parse: vi.fn(),
  managers: [] as Array<{ resolveURL(url: string): string }>,
}));
vi.mock("../three-runtime", () => ({ getThreeRuntime: vi.fn() }));
vi.mock("../vrm-cache", () => ({ getVrmCache: () => ({ getBytes: mock.getBytes }) }));
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    constructor(manager: { resolveURL(url: string): string }) {
      mock.managers.push(manager);
    }
    register() {}
    parseAsync(bytes: ArrayBuffer) {
      return mock.parse(bytes);
    }
  },
}));

function glb(extensions: object = { VRMC_vrm: {} }) {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, extensions }));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + length);
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, length, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  return bytes;
}

function model() {
  const scene = new Group();
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  const geometryDispose = vi.spyOn(geometry, "dispose");
  const materialDispose = vi.spyOn(material, "dispose");
  scene.add(new Mesh(geometry, material));
  const vrm = {
    scene,
    meta: { metaVersion: "1" },
    humanoid: {
      resetNormalizedPose: vi.fn(),
      getNormalizedBoneNode: vi.fn(() => null),
      setNormalizedPose: vi.fn(),
      getNormalizedPose: vi.fn(() => ({})),
    },
    expressionManager: { setValue: vi.fn() },
    lookAt: { autoUpdate: true, yaw: 0, pitch: 0 },
    update: vi.fn(),
  } as unknown as VRM;
  return { vrm, gltf: { scene, userData: { vrm } }, geometryDispose, materialDispose };
}

const issued: string[] = [];
function issueUrl() {
  const url = createCallAvatarUrl(glb());
  issued.push(url);
  return url;
}

function harness() {
  const resident = model();
  const peer = model();
  const scene = new Scene();
  const light = new HemisphereLight();
  const furniture = new Group();
  scene.add(light, resident.vrm.scene, furniture);
  const camera = new PerspectiveCamera(35, 1.8, 0.1, 20);
  camera.position.set(0.1, 1.4, 1.1);
  const originalCamera = camera.position.clone();
  let current: VRM | null = resident.vrm;
  const frames = new Set<(delta: number, elapsed: number) => void>();
  const disposeCamera = vi.fn(() => camera.position.copy(originalCamera));
  const targetCamera = vi.fn((x: number, y: number, z: number) => camera.position.set(x, y, z));
  const runtime = {
    getScene: () => scene,
    getCamera: () => camera,
    getVrm: () => current,
    subscribeFrame: (listener: (delta: number, elapsed: number) => void) => {
      frames.add(listener);
      return () => {
        frames.delete(listener);
      };
    },
    acquireFixedCamera: vi.fn((x: number, y: number, z: number) => {
      targetCamera(x, y, z);
      return { dispose: disposeCamera, setTarget: targetCamera };
    }),
  };
  const pose: AvatarMotionPose = {
    root: [0.05, 0.02, 0],
    hips: [0, 0, 0],
    gaze: [8, 2],
    bones: AVATAR_MOTION_BONES.map(() => null),
    expressions: AVATAR_MOTION_EXPRESSIONS.map(() => 0),
  };
  const source = {
    avatarUrl: issueUrl(),
    sampleMotion: vi.fn(() => pose),
    sampleMouth: vi.fn(() => 0.65),
    onState: vi.fn(),
  };
  mock.parse.mockResolvedValue(peer.gltf);
  const tick = () => {
    for (const frame of frames) frame(0.033, 1);
  };
  return {
    resident,
    peer,
    scene,
    light,
    furniture,
    camera,
    runtime,
    source,
    frames,
    tick,
    disposeCamera,
    targetCamera,
    originalCamera,
    setCurrent: (vrm: VRM | null) => {
      current = vrm;
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  const OriginalURL = URL;
  mock.createObjectURL
    .mockReset()
    .mockImplementation(() => `blob:${window.location.origin}/${crypto.randomUUID()}`);
  mock.revokeObjectURL.mockReset();
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = mock.createObjectURL;
      static revokeObjectURL = mock.revokeObjectURL;
    },
  );
  mock.getBytes.mockReset().mockResolvedValue(glb());
  mock.parse.mockReset();
  mock.managers.length = 0;
});

afterEach(() => {
  for (const url of issued.splice(0)) revokeCallAvatarUrl(url);
  vi.unstubAllGlobals();
});

describe("main theater peer resident", () => {
  it("uses the real main scene and local Body model, drives only the peer, restores ownership on leave", async () => {
    const h = harness();
    const localTransform = h.resident.vrm.scene.position.clone();
    const children = [...h.scene.children];
    const display = attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    expect(h.source.onState).toHaveBeenLastCalledWith("ready");
    expect(mock.parse).toHaveBeenCalledOnce();
    expect(h.resident.vrm.scene.parent?.position.x).toBeLessThan(0);
    expect(h.peer.vrm.scene.parent?.position.x).toBeGreaterThan(0);
    expect(h.peer.vrm.scene.parent?.parent).toBe(h.scene);
    expect(h.scene.children).toContain(h.light);
    expect(h.scene.children).toContain(h.furniture);
    h.tick();
    expect(h.peer.vrm.scene.position.toArray()).toEqual([0.05, 0.02, 0]);
    expect(h.peer.vrm.expressionManager?.setValue).toHaveBeenCalledWith("aa", 0.65);
    expect(h.peer.vrm.lookAt?.yaw).toBe(8);
    expect(h.resident.vrm.humanoid.setNormalizedPose).not.toHaveBeenCalled();
    expect(h.resident.vrm.expressionManager?.setValue).not.toHaveBeenCalled();
    expect(h.resident.vrm.scene.position).toEqual(localTransform);
    // Normal Body animation keeps owning the root while the peer is present.
    h.resident.vrm.scene.position.y = 0.09;
    display.dispose();
    display.dispose();
    expect(h.scene.children).toEqual(children);
    expect(h.resident.vrm.scene.position.y).toBe(0.09);
    expect(h.resident.geometryDispose).not.toHaveBeenCalled();
    expect(h.resident.materialDispose).not.toHaveBeenCalled();
    expect(h.peer.geometryDispose).toHaveBeenCalledOnce();
    expect(h.peer.materialDispose).toHaveBeenCalledOnce();
    expect(h.frames.size).toBe(0);
    expect(h.disposeCamera).not.toHaveBeenCalled();
    expect(h.camera.position).toEqual(h.originalCamera);
  });

  it("adjusts placement on resize while preserving the exact camera and its ownership", async () => {
    const h = harness();
    const display = attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    const wide = h.peer.vrm.scene.parent?.position.x ?? 0;
    const position = h.camera.position.clone();
    const quaternion = h.camera.quaternion.clone();
    const fov = h.camera.fov;
    h.camera.aspect = 0.7;
    h.tick();
    expect(h.peer.vrm.scene.parent?.position.x).toBeLessThan(wide);
    expect(h.camera.position).toEqual(position);
    expect(h.camera.quaternion.toArray()).toEqual(quaternion.toArray());
    expect(h.camera.fov).toBe(fov);
    expect(h.runtime.acquireFixedCamera).not.toHaveBeenCalled();
    expect(mock.parse).toHaveBeenCalledOnce();
    expect(h.frames.size).toBe(1);
    display.dispose();
  });

  it("does not resurrect the previous local avatar after replacement", async () => {
    const h = harness();
    const display = attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    const next = model();
    h.resident.vrm.scene.removeFromParent();
    h.scene.add(next.vrm.scene);
    h.setCurrent(next.vrm);
    h.tick();
    expect(next.vrm.scene.parent?.position.x).toBeLessThan(0);
    display.dispose();
    expect(next.vrm.scene.parent).toBe(h.scene);
    expect(h.resident.vrm.scene.parent).toBeNull();
    expect(next.geometryDispose).not.toHaveBeenCalled();
  });

  it("disposes a late decode after theater was left without changing the local scene or camera", async () => {
    const h = harness();
    let resolve: ((value: typeof h.peer.gltf) => void) | undefined;
    mock.parse.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const children = [...h.scene.children];
    const display = attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    display.dispose();
    resolve?.(h.peer.gltf);
    await settle();
    expect(h.peer.geometryDispose).toHaveBeenCalledOnce();
    expect(h.scene.children).toEqual(children);
    expect(h.runtime.acquireFixedCamera).not.toHaveBeenCalled();
    expect(h.source.onState).not.toHaveBeenCalledWith("ready");
  });

  it("keeps the local avatar untouched when GLB preflight fails", async () => {
    const h = harness();
    mock.getBytes.mockResolvedValue(
      glb({ VRMC_vrm: {}, malicious: { uri: "https://outside.invalid/model" } }),
    );
    const display = attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    expect(mock.parse).not.toHaveBeenCalled();
    expect(h.resident.vrm.scene.parent).toBe(h.scene);
    expect(h.source.onState).toHaveBeenLastCalledWith("error", expect.any(String));
    expect(h.frames.size).toBe(0);
    display.dispose();
  });

  it("accepts only locally issued call-avatar URLs and blocks external loader requests", async () => {
    const h = harness();
    expect(isTransferredAvatarUrl(h.source.avatarUrl)).toBe(true);
    for (const url of [
      "/local.vrm",
      `blob:${window.location.origin}/unissued`,
      "blob:null/peer-supplied",
      "https://outside.invalid/file.vrm",
      "blob:https://outside.invalid/id",
      "data:application/octet-stream;base64,AA==",
    ])
      expect(isTransferredAvatarUrl(url)).toBe(false);
    const display = attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    expect(mock.managers[0].resolveURL(h.source.avatarUrl)).toBe(h.source.avatarUrl);
    expect(() => mock.managers[0].resolveURL("https://outside.invalid/image.png")).toThrow();
    display.dispose();
  });

  it.each([
    "blob:null/opaque-owned-avatar",
    "blob:tauri://localhost/owned-avatar",
  ])("loads a locally issued native opaque-origin avatar %s and rejects unissued lookalikes", async (url) => {
    mock.createObjectURL.mockReturnValueOnce(url);
    const h = harness();
    const display = attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    expect(h.source.avatarUrl).toBe(url);
    expect(isTransferredAvatarUrl(url)).toBe(true);
    expect(isTransferredAvatarUrl(`${url}-other`)).toBe(false);
    expect(h.source.onState).toHaveBeenLastCalledWith("ready");
    expect(mock.parse).toHaveBeenCalledOnce();
    display.dispose();
    revokeCallAvatarUrl(url);
    expect(isTransferredAvatarUrl(url)).toBe(false);
    expect(mock.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("does not load a revoked avatar URL even if its bytes remain in cache", async () => {
    const h = harness();
    revokeCallAvatarUrl(h.source.avatarUrl);
    attachTheaterCallPeer(h.source, h.runtime);
    await settle();
    expect(mock.getBytes).not.toHaveBeenCalled();
    expect(mock.parse).not.toHaveBeenCalled();
    expect(h.source.onState).toHaveBeenLastCalledWith("error", expect.any(String));
    expect(h.resident.vrm.scene.parent).toBe(h.scene);
  });

  it("keeps spacing proportional to the existing frustum and zoom", () => {
    for (const aspect of [0.7, 1, 1.8, 2.5]) {
      const spacing = theaterCallSpacing(1.1, aspect, 35);
      const halfWidth = 1.1 * Math.tan((35 * Math.PI) / 360) * aspect;
      expect(spacing).toBeLessThanOrEqual(halfWidth * 0.52);
      expect(spacing).toBeLessThanOrEqual(0.5);
      expect(theaterCallSpacing(1.1, aspect, 35, 2)).toBeLessThan(spacing);
    }
    expect(theaterCallSpacing(-1, 1, 35)).toBe(0);
    expect(theaterCallSpacing(1, Number.NaN, 35)).toBe(0);
  });
});

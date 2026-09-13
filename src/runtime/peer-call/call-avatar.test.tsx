// @vitest-environment jsdom

import type { VRM } from "@pixiv/three-vrm";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  type Scene,
  Vector3,
} from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenePackManifest } from "../../sdk/scene-pack";
import {
  AVATAR_MOTION_BONES,
  AVATAR_MOTION_EXPRESSIONS,
  type AvatarMotionPose,
} from "./avatar-motion";
import { NativeCallAvatar, NativeCallStage } from "./call-avatar";
import type { RemoteCallCamera } from "./remote-call-window";

const mocks = vi.hoisted(() => ({
  getBytes: vi.fn(),
  parse: vi.fn(),
  renderers: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
  }>,
  hosts: [] as Array<{
    render: ReturnType<typeof vi.fn>;
    advance: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    deps: { scene: Scene; camera: PerspectiveCamera; canvas: HTMLCanvasElement };
  }>,
  canvases: [] as HTMLCanvasElement[],
  managers: [] as Array<{ resolveURL: (value: string) => string }>,
}));

vi.mock("../three-runtime/r3f-host", () => ({
  R3fHost: class {
    render = vi.fn(() => true);
    advance = vi.fn(() => true);
    dispose = vi.fn();
    constructor(
      public deps: { scene: Scene; camera: PerspectiveCamera; canvas: HTMLCanvasElement },
    ) {
      mocks.hosts.push(this);
    }
    initialize = async () => {
      Object.assign(this.deps.canvas.style, { width: "300px", height: "150px" });
    };
    setSize(width: number, height: number) {
      Object.assign(this.deps.canvas.style, { width: `${width}px`, height: `${height}px` });
    }
  },
}));
vi.mock("./call-scene-root", () => ({ CallSceneRoot: () => null }));
vi.mock("../../core/scene/procedural-scene-layer", () => ({
  ProceduralSceneLayer: () => <div data-testid="procedural-background" />,
}));
vi.mock("../vrm-cache", () => ({ getVrmCache: () => ({ getBytes: mocks.getBytes }) }));
vi.mock("./avatar-transfer", () => ({
  validateAvatarGlb: (bytes: ArrayBuffer) => bytes.byteLength === 24,
}));
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    constructor(manager: { resolveURL: (value: string) => string }) {
      mocks.managers.push(manager);
    }
    register() {}
    parseAsync(bytes: ArrayBuffer) {
      return mocks.parse(bytes);
    }
  },
}));
vi.mock("three", async (importOriginal) => {
  const original = await importOriginal<typeof import("three")>();
  return {
    ...original,
    WebGLRenderer: class {
      dispose = vi.fn();
      render = vi.fn();
      shadowMap = { enabled: false, type: 1 };
      constructor({ canvas }: { canvas: HTMLCanvasElement }) {
        mocks.canvases.push(canvas);
        mocks.renderers.push(this);
      }
      setPixelRatio() {}
      setSize = vi.fn();
      forceContextLoss() {}
    },
  };
});

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
      getNormalizedPose: vi.fn(() => ({})),
      getNormalizedBoneNode: vi.fn(() => null),
      setNormalizedPose: vi.fn(),
    },
    expressionManager: { setValue: vi.fn() },
    lookAt: { yaw: 0, pitch: 0, autoUpdate: true },
    update: vi.fn(),
  } as unknown as VRM;
  return { gltf: { scene, userData: { vrm } }, vrm, geometryDispose, materialDispose };
}

let frames: Map<number, FrameRequestCallback>;
let counter = 0;

beforeEach(() => {
  mocks.getBytes.mockReset().mockResolvedValue(new ArrayBuffer(8));
  mocks.parse.mockReset();
  mocks.renderers.length = 0;
  mocks.managers.length = 0;
  mocks.hosts.length = 0;
  mocks.canvases.length = 0;
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++counter;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tick() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}

describe("native call VRM renderer ownership", () => {
  it("parses an owned clone of native-validated bytes even for an opaque-origin blob", async () => {
    const loaded = model();
    mocks.parse.mockResolvedValue(loaded.gltf);
    const bytes = new ArrayBuffer(24);
    render(
      <NativeCallAvatar
        avatarUrl="blob:null/native-owned"
        avatarBytes={bytes}
        label="Remote"
        sampleMotion={() => null}
      />,
    );
    await act(async () => {});
    expect(mocks.getBytes).not.toHaveBeenCalled();
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(mocks.parse.mock.calls[0][0]).not.toBe(bytes);
    expect(mocks.parse.mock.calls[0][0]).toEqual(bytes);
  });

  it("rejects invalid inline bytes before starting the renderer or parsing", () => {
    render(
      <NativeCallAvatar
        avatarUrl="blob:null/native-owned"
        avatarBytes={new ArrayBuffer(8)}
        label="Remote"
        sampleMotion={() => null}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.getBytes).not.toHaveBeenCalled();
  });
  it("inherits the existing main camera instead of applying separate call framing", async () => {
    const loaded = model();
    mocks.parse.mockResolvedValue(loaded.gltf);
    const camera = {
      position: [0.3, 1.5, 0.84] as [number, number, number],
      quaternion: [0, 0, 0, 1] as [number, number, number, number],
      fov: 42,
      zoom: 1.3,
      near: 0.1,
      far: 30,
      anchorY: 1.5,
    };
    render(
      <NativeCallAvatar
        avatarUrl="/avatar.vrm"
        label="Remote"
        sampleMotion={() => null}
        sampleCamera={() => camera}
      />,
    );
    await act(async () => {});
    act(tick);
    const calls = mocks.renderers[0].render.mock.calls;
    const rendered = calls[calls.length - 1][1];
    expect(rendered.position.toArray()).toEqual(camera.position);
    expect(rendered.fov).toBe(42);
    expect(rendered.zoom).toBe(1.3);
    camera.position = [0.1, 1.6, 1.2];
    act(tick);
    expect(rendered.position.toArray()).toEqual([0.1, 1.6, 1.2]);
    expect(mocks.parse).toHaveBeenCalledOnce();
  });

  it.each([
    "0",
    "1",
  ] as const)("preserves main's framing for a posed, translated VRM %s without changing the model's proportions", async (metaVersion) => {
    const loaded = model();
    loaded.vrm.meta.metaVersion = metaVersion;
    const hips = new Group();
    const head = new Group();
    head.position.set(0.12, 1.4, -0.08);
    hips.add(head);
    loaded.vrm.scene.add(hips);
    // Keep a model-authored transform, including scale, rather than assuming identity roots.
    loaded.vrm.scene.scale.set(0.9, 1.15, 1.05);
    loaded.vrm.scene.rotation.set(0.03, 0.2, -0.02);
    vi.mocked(loaded.vrm.humanoid.getNormalizedBoneNode).mockImplementation((name) =>
      name === "head" ? head : name === "hips" ? hips : null,
    );
    vi.mocked(loaded.vrm.humanoid.setNormalizedPose).mockImplementation((pose) => {
      hips.position.fromArray(pose.hips?.position ?? [0, 0, 0]);
    });
    mocks.parse.mockResolvedValue(loaded.gltf);
    const motion: AvatarMotionPose = {
      bones: AVATAR_MOTION_BONES.map(() => null),
      hips: [0.17, -0.23, 0.11],
      root: [0.4, 0.08, -0.2],
      gaze: [0, 0],
      expressions: AVATAR_MOTION_EXPRESSIONS.map(() => 0),
    };
    const main = new PerspectiveCamera(43, 1, 0.07, 55);
    main.position.set(0.3, 1.7, 1.2);
    main.lookAt(0.08, 1.65, 0.04);
    main.zoom = 1.27;
    main.updateProjectionMatrix();
    const inherited: RemoteCallCamera = {
      position: main.position.toArray(),
      quaternion: main.quaternion.toArray(),
      fov: main.fov,
      zoom: main.zoom,
      near: main.near,
      far: main.far,
      anchor: [0.08, 1.58, 0.04],
      anchorY: 1.58,
    };
    render(
      <NativeCallAvatar
        avatarUrl="/avatar.vrm"
        label="Remote"
        sampleMotion={() => motion}
        sampleCamera={() => inherited}
      />,
    );
    await act(async () => {});
    const scale = loaded.vrm.scene.scale.clone();
    const rotation = loaded.vrm.scene.quaternion.clone();

    const expectSameFraming = () => {
      act(tick);
      const calls = mocks.renderers[0].render.mock.calls;
      const peerCamera = calls[calls.length - 1][1] as PerspectiveCamera;
      peerCamera.updateMatrixWorld(true);
      main.updateMatrixWorld(true);
      const peerAnchor = head.getWorldPosition(new Vector3());
      const mainAnchor = new Vector3().fromArray(inherited.anchor ?? []);
      // A head and another same-distance point must project identically, covering framing,
      // perspective depth, quaternion and zoom rather than just checking copied fields.
      for (const offset of [new Vector3(), new Vector3(0.1, -0.2, 0.03)]) {
        const peerNdc = peerAnchor.clone().add(offset).project(peerCamera);
        const mainNdc = mainAnchor.clone().add(offset).project(main);
        expect(peerNdc.distanceTo(mainNdc)).toBeLessThan(1e-10);
      }
      expect(peerCamera.quaternion.toArray()).toEqual(inherited.quaternion);
      expect(loaded.vrm.scene.scale.toArray()).toEqual(scale.toArray());
      expect(loaded.vrm.scene.quaternion.toArray()).toEqual(rotation.toArray());
      expect(loaded.vrm.scene.position.toArray()).toEqual(motion.root);
      expect(loaded.vrm.scene.parent?.position.toArray()).toEqual([0, 0, 0]);
    };
    expectSameFraming();

    // Both sides move after the initial VRM load. A stored rest head or Y-only adjustment
    // cannot keep the corresponding head projection through this frame.
    motion.hips = [-0.12, 0.06, -0.14];
    motion.root = [-0.2, -0.04, 0.15];
    inherited.anchor = [-0.1, 1.62, -0.08];
    inherited.anchorY = 1.62;
    expectSameFraming();
    expect(mocks.parse).toHaveBeenCalledOnce();
  });

  it("uses the live posed height for older camera frames that carry only anchorY", async () => {
    const loaded = model();
    const head = new Group();
    head.position.set(0.2, 1.4, -0.1);
    loaded.vrm.scene.add(head);
    vi.mocked(loaded.vrm.humanoid.getNormalizedBoneNode).mockImplementation((name) =>
      name === "head" ? head : null,
    );
    mocks.parse.mockResolvedValue(loaded.gltf);
    const camera: RemoteCallCamera = {
      position: [0.3, 1.65, 1.1],
      quaternion: [0, 0, 0, 1],
      fov: 35,
      near: 0.1,
      far: 20,
      anchorY: 1.6,
    };
    render(
      <NativeCallAvatar
        avatarUrl="/avatar.vrm"
        label="Remote"
        sampleMotion={() => null}
        sampleCamera={() => camera}
      />,
    );
    await act(async () => {});
    head.position.y = 1.2;
    act(tick);
    const calls = mocks.renderers[0].render.mock.calls;
    const rendered = calls[calls.length - 1][1] as PerspectiveCamera;
    expect(rendered.position.x).toBe(camera.position[0]);
    expect(rendered.position.y).toBeCloseTo(1.25);
    expect(rendered.position.z).toBe(camera.position[2]);
  });

  it("uses one scene for theater but distinct mutable VRMs even when the local asset URL is identical", async () => {
    const a = model();
    const b = model();
    mocks.parse.mockResolvedValueOnce(a.gltf).mockResolvedValueOnce(b.gltf);
    const participants = [
      { avatarUrl: "/avatar.vrm", label: "A", sampleMotion: () => null, sampleMouth: () => 0.8 },
      { avatarUrl: "/avatar.vrm", label: "B", sampleMotion: () => null, sampleMouth: () => 0.1 },
    ];
    const view = render(<NativeCallStage participants={participants} layout="theater" />);
    await act(async () => {});
    expect(mocks.renderers).toHaveLength(1);
    expect(mocks.parse).toHaveBeenCalledTimes(2);
    expect(a.vrm.scene.parent).not.toBe(b.vrm.scene.parent);
    expect(a.vrm.scene.parent?.parent).toBe(b.vrm.scene.parent?.parent);
    expect(a.vrm.scene.parent?.position.x).toBeLessThan(b.vrm.scene.parent?.position.x ?? 0);
    act(tick);
    expect(a.vrm.expressionManager?.setValue).toHaveBeenCalledWith("aa", 0.8);
    expect(b.vrm.expressionManager?.setValue).toHaveBeenCalledWith("aa", 0.1);
    view.unmount();
    expect(a.geometryDispose).toHaveBeenCalledOnce();
    expect(b.materialDispose).toHaveBeenCalledOnce();
    expect(mocks.renderers[0].dispose).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("updates live samples without reloading or disposing the avatar when React rerenders", async () => {
    const loaded = model();
    mocks.parse.mockResolvedValue(loaded.gltf);
    const props = { avatarUrl: "/avatar.vrm", label: "A", sampleMotion: () => null };
    const view = render(<NativeCallAvatar {...props} sampleMouth={() => 0.2} />);
    await act(async () => {});
    view.rerender(
      <NativeCallAvatar {...props} sampleMouth={() => ({ aa: 0, ih: 0.7, ou: 0, ee: 0, oh: 0 })} />,
    );
    act(tick);
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(loaded.vrm.expressionManager?.setValue).toHaveBeenCalledWith("ih", 0.7);
    expect(loaded.geometryDispose).not.toHaveBeenCalled();
  });

  it("disposes a late parse result after unmount and never inserts it into a live scene", async () => {
    const loaded = model();
    let resolve: (result: typeof loaded.gltf) => void = () => {};
    mocks.parse.mockReturnValue(
      new Promise<typeof loaded.gltf>((done) => {
        resolve = done;
      }),
    );
    const view = render(
      <NativeCallAvatar avatarUrl="/avatar.vrm" label="A" sampleMotion={() => null} />,
    );
    await act(async () => {});
    view.unmount();
    await act(async () => {
      resolve(loaded.gltf);
    });
    expect(loaded.geometryDispose).toHaveBeenCalledOnce();
    expect(loaded.vrm.scene.parent).toBeNull();
    expect(loaded.vrm.update).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("blocks external assets before loading and rejects embedded GLB references to network services", async () => {
    const view = render(
      <NativeCallAvatar
        avatarUrl="https://peer.example/avatar.vrm"
        label="A"
        sampleMotion={() => null}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("この端末");
    expect(mocks.getBytes).not.toHaveBeenCalled();
    const loaded = model();
    mocks.parse.mockResolvedValue(loaded.gltf);
    view.rerender(<NativeCallAvatar avatarUrl="/avatar.vrm" label="A" sampleMotion={() => null} />);
    await act(async () => {});
    const manager = mocks.managers[0];
    expect(() => manager.resolveURL("https://peer.example/texture.png")).toThrow();
    expect(() => manager.resolveURL("http://localhost:9000/private")).toThrow();
    expect(manager.resolveURL("blob:http://localhost/embedded")).toBe(
      "blob:http://localhost/embedded",
    );
    expect(manager.resolveURL("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
  });

  it("uses separate renderers for call or portrait presentation", async () => {
    mocks.parse.mockImplementation(async () => model().gltf);
    render(
      <NativeCallStage
        participants={[
          { avatarUrl: "/avatar.vrm", label: "A", sampleMotion: () => null },
          { avatarUrl: "/avatar.vrm", label: "B", sampleMotion: () => null },
        ]}
        layout="portrait"
      />,
    );
    await act(async () => {});
    expect(mocks.renderers).toHaveLength(2);
    expect(screen.getByLabelText("A")).toBeTruthy();
    expect(screen.getByLabelText("B")).toBeTruthy();
  });
});

it("loads a selected scene into the avatar renderer and lets its composer own rendering", async () => {
  mocks.parse.mockImplementation(async () => model().gltf);
  const entry = {
    id: "room",
    origin: "bundled" as const,
    manifest: {} as ScenePackManifest,
    scene: { id: "room", layers: [] },
    component: () => null,
  };
  const appearance = {
    source: { origin: "bundled" as const, id: "room" },
    scene: entry.scene,
    controls: { "light.fill": 0.8 },
    background: "#141619",
    renderer: {
      toneMapping: 4,
      toneMappingExposure: 1.2,
      outputColorSpace: "srgb",
      shadowMapEnabled: true,
      shadowMapType: 2,
    },
  };
  const props = {
    avatarUrl: "/avatar.vrm",
    label: "Remote",
    sampleMotion: () => null,
    sceneEntry: entry,
    appearance,
  };
  const view = render(<NativeCallAvatar {...props} />);
  await act(async () => {});
  expect(mocks.hosts).toHaveLength(1);
  expect(mocks.hosts[0].deps.scene.children.some((item) => "isLight" in item && item.isLight)).toBe(
    false,
  );
  act(tick);
  expect(mocks.hosts[0].advance).toHaveBeenCalled();
  expect(mocks.renderers[0].render).not.toHaveBeenCalled();
  expect(
    (mocks.renderers[0] as unknown as { toneMappingExposure: number }).toneMappingExposure,
  ).toBe(1.2);
  view.rerender(
    <NativeCallAvatar {...props} appearance={{ ...appearance, controls: { "light.fill": 1.5 } }} />,
  );
  expect(mocks.hosts).toHaveLength(1);
  expect(mocks.parse).toHaveBeenCalledOnce();
  view.rerender(<NativeCallAvatar {...props} avatarUrl="/another.vrm" />);
  await act(async () => {});
  expect(mocks.hosts[0].dispose).toHaveBeenCalledOnce();
  expect(mocks.canvases[0]).not.toBe(mocks.canvases[1]);
  expect(mocks.canvases[0].isConnected).toBe(false);
});

it("preserves a component failure across setting updates and ignores errors from the replaced scene", async () => {
  mocks.parse.mockImplementation(async () => model().gltf);
  const entry = {
    id: "room",
    origin: "bundled" as const,
    manifest: {} as ScenePackManifest,
    scene: { id: "room", layers: [] },
    component: () => null,
  };
  const props = {
    avatarUrl: "/avatar.vrm",
    label: "Remote",
    sampleMotion: () => null,
    sceneEntry: entry,
    appearance: null,
  };
  const view = render(<NativeCallAvatar {...props} />);
  await act(async () => {});
  const previous = mocks.hosts[0].render.mock.lastCall?.[0] as { props: { onError(): void } };
  act(() => previous.props.onError());
  expect(screen.getByRole("alert").textContent).toBe("シーンを表示できませんでした。");
  view.rerender(<NativeCallAvatar {...props} sceneEntry={{ ...entry }} />);
  expect(screen.getByRole("alert").textContent).toBe("シーンを表示できませんでした。");
  view.rerender(<NativeCallAvatar {...props} sceneEntry={{ ...entry, component: () => null }} />);
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => previous.props.onError());
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps one VRM, renderer and canvas through cafe, loading gap and grassland scene slots", async () => {
  const loaded = model();
  mocks.parse.mockResolvedValue(loaded.gltf);
  const cafe = {
    id: "cafe",
    origin: "bundled" as const,
    manifest: {} as ScenePackManifest,
    scene: {
      id: "cafe",
      layers: [
        { id: "cafe-resident", role: "character" as const, blur: 0 },
        { id: "cafe-vignette", role: "foreground" as const, backgroundColor: "transparent" },
      ],
    },
    component: () => null,
  };
  const grass = {
    ...cafe,
    id: "misty-grasslands",
    component: () => null,
    scene: {
      id: "misty-grasslands",
      layers: [
        {
          id: "grass",
          role: "background" as const,
          procedural: { kind: "misty-grasslands" as const },
          blur: 1,
        },
        { id: "grass-resident", role: "character" as const, blur: 0 },
        { id: "haze", role: "foreground" as const, backgroundColor: "transparent" },
      ],
    },
  };
  const props = {
    avatarUrl: "/avatar.vrm",
    label: "Mai",
    sampleMotion: () => null,
    appearance: null,
  };
  const view = render(<NativeCallAvatar {...props} sceneEntry={cafe} />);
  await act(async () => {});
  const canvas = mocks.canvases[0];
  const oldSlot = canvas.closest('[data-layer-id="cafe-resident"]');
  expect(oldSlot).not.toBeNull();
  view.rerender(<NativeCallAvatar {...props} sceneEntry={null} />);
  expect(canvas.isConnected).toBe(true);
  expect(oldSlot?.isConnected).toBe(false);
  view.rerender(<NativeCallAvatar {...props} sceneEntry={grass} />);
  await act(async () => {});
  expect(canvas.closest('[data-layer-id="grass-resident"]')).not.toBeNull();
  expect(screen.getByTestId("procedural-background")).toBeTruthy();
  expect(mocks.canvases).toEqual([canvas]);
  expect(mocks.renderers).toHaveLength(1);
  expect(mocks.hosts).toHaveLength(1);
  expect(mocks.parse).toHaveBeenCalledOnce();
  expect(mocks.hosts[0].dispose).not.toHaveBeenCalled();
  expect(loaded.geometryDispose).not.toHaveBeenCalled();
  act(tick);
  expect(mocks.hosts[0].advance).toHaveBeenCalled();
  expect(canvas.isConnected).toBe(true);
  view.unmount();
  expect(mocks.hosts[0].dispose).toHaveBeenCalledOnce();
  expect(loaded.geometryDispose).toHaveBeenCalledOnce();
});

it("fills the resized terminal viewport even when R3F fixes its canvas to the old pixel size", async () => {
  mocks.parse.mockResolvedValue(model().gltf);
  let width = 1200;
  const height = 670;
  let resize = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    // The sidebar's available viewport changes; canvas CSS can still reflect R3F's
    // previous size or its intrinsic 300 x 150 startup fallback.
    return this.classList.contains("call-resident-panel-avatar")
      ? new DOMRect(0, 0, width, height)
      : new DOMRect(0, 0, 300, 150);
  });
  const view = render(
    <NativeCallAvatar
      avatarUrl="/avatar.vrm"
      label="Mai"
      className="call-resident-panel-avatar"
      sampleMotion={() => null}
      appearance={null}
    />,
  );
  await act(async () => {});
  const viewport = view.container.firstElementChild as HTMLDivElement;
  const canvas = mocks.canvases[0];
  expect(viewport.style.width).toBe("100%");
  expect(viewport.style.height).toBe("100%");
  expect(observe).toHaveBeenCalledWith(viewport);
  expect(observe).not.toHaveBeenCalledWith(canvas);

  width = 280;
  act(resize);
  expect(mocks.renderers[0].setSize).toHaveBeenLastCalledWith(280, 670, false);
  expect(mocks.hosts[0].deps.camera.aspect).toBeCloseTo(280 / 670);
  expect(canvas.style.width).toBe("100%");
  expect(canvas.style.height).toBe("100%");
  expect(mocks.canvases).toEqual([canvas]);
  expect(mocks.parse).toHaveBeenCalledOnce();
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("retains its loaded VRM and scene while hidden and stops its animation frames until resumed", async () => {
  const loaded = model();
  mocks.parse.mockResolvedValue(loaded.gltf);
  const props = {
    avatarUrl: "/avatar.vrm",
    label: "Mai",
    sampleMotion: () => null,
    appearance: null,
  };
  const view = render(<NativeCallAvatar {...props} active />);
  await act(async () => {});
  act(tick);
  const canvas = mocks.canvases[0];
  expect(frames.size).toBe(1);
  view.rerender(<NativeCallAvatar {...props} active={false} />);
  expect(frames.size).toBe(0);
  const rendered = mocks.hosts[0].advance.mock.calls.length;
  act(tick);
  expect(mocks.hosts[0].advance).toHaveBeenCalledTimes(rendered);
  expect(mocks.hosts[0].dispose).not.toHaveBeenCalled();
  expect(loaded.geometryDispose).not.toHaveBeenCalled();

  view.rerender(<NativeCallAvatar {...props} active />);
  expect(frames.size).toBe(1);
  act(tick);
  expect(mocks.hosts[0].advance).toHaveBeenCalledTimes(rendered + 1);
  expect(mocks.parse).toHaveBeenCalledOnce();
  expect(mocks.canvases).toEqual([canvas]);
  expect(mocks.renderers).toHaveLength(1);
  expect(mocks.hosts).toHaveLength(1);
  view.unmount();
  expect(frames.size).toBe(0);
  expect(mocks.hosts[0].dispose).toHaveBeenCalledOnce();
});

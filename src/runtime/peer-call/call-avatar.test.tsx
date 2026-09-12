// @vitest-environment jsdom

import type { VRM } from "@pixiv/three-vrm";
import { act, cleanup, render, screen } from "@testing-library/react";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeCallAvatar, NativeCallStage } from "./call-avatar";

const mocks = vi.hoisted(() => ({
  getBytes: vi.fn(),
  parse: vi.fn(),
  renderers: [] as Array<{ dispose: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> }>,
  managers: [] as Array<{ resolveURL: (value: string) => string }>,
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
      constructor() {
        mocks.renderers.push(this);
      }
      setPixelRatio() {}
      setSize() {}
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

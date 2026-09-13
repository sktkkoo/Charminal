import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWindowView } from "../auxiliary-windows";
import {
  type RemoteCallWindowFrame,
  RemoteCallWindowHost,
  type RemoteCallWindowModel,
  startRemoteCallRelay,
} from "./remote-call-window";

vi.mock("./avatar-transfer", () => ({
  validateAvatarGlb: (bytes: ArrayBuffer) => bytes.byteLength === 24,
}));

function model(): RemoteCallWindowModel {
  return {
    ownerKey: "room:remote",
    visible: true,
    label: "Mafu",
    language: "ja",
    mode: "call",
    avatarUrl: null,
    sampleMotion: () => null,
    sampleMouth: () => ({ aa: 0.1, ih: 0.2, ou: 0.3, ee: 0.4, oh: 0.5 }),
    sampleCamera: () => ({
      position: [0, 1.6, 0.84],
      quaternion: [0, 0, 0, 1],
      fov: 35,
      near: 0.1,
      far: 20,
      anchorY: 1.58,
    }),
  };
}
afterEach(() => vi.useRealTimers());

describe("remote native resident projection", () => {
  it("requires both the native label and bundled route", () => {
    expect(resolveWindowView("auxiliary-call-resident", "?auxiliary=call-resident")).toBe(
      "call-resident",
    );
    expect(resolveWindowView("auxiliary-call-resident", "?auxiliary=camera-preview")).toBeNull();
    expect(resolveWindowView("unknown", "?auxiliary=call-resident")).toBeNull();
    expect(resolveWindowView("main", "?auxiliary=call-resident")).toBe("main");
  });
  it("projects existing camera/mouth, skips backed-up publications, and stops on cleanup", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const publish = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const source = model();
    const stop = startRemoteCallRelay(() => source, "lease", publish, vi.fn(), vi.fn());
    expect(publish.mock.calls[0]).toEqual([
      {
        leaseId: "lease",
        label: "Mafu",
        language: "ja",
        mode: "call",
        visible: true,
        motion: null,
        mouth: [0.1, 0.2, 0.3, 0.4, 0.5],
        camera: source.sampleCamera(),
      },
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(40);
    expect(publish).toHaveBeenCalledTimes(2);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it("uploads avatar bytes once and fences a pending avatar read after close", async () => {
    vi.useFakeTimers();
    const source = { ...model(), avatarUrl: "blob:local-avatar" };
    const getBytes = vi.fn(async () => new ArrayBuffer(24));
    const upload = vi.fn(async () => {});
    const stop = startRemoteCallRelay(
      () => source,
      "lease",
      vi.fn(async () => {}),
      upload,
      vi.fn(),
      getBytes,
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(getBytes).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    source.visible = false;
    await vi.advanceTimersByTimeAsync(300);
    source.mode = "portrait";
    source.visible = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(getBytes).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    source.avatarUrl = "blob:replacement-avatar";
    await vi.advanceTimersByTimeAsync(100);
    expect(getBytes).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(2);
    stop();
    let finish!: (bytes: ArrayBuffer) => void;
    const delayed = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    );
    const stoppedUpload = vi.fn();
    const stopPending = startRemoteCallRelay(
      () => source,
      "next",
      vi.fn(async () => {}),
      stoppedUpload,
      vi.fn(),
      delayed,
    );
    stopPending();
    finish(new ArrayBuffer(24));
    await vi.advanceTimersByTimeAsync(100);
    expect(stoppedUpload).not.toHaveBeenCalled();
  });
});

it("retains one native lease and scene across view modes, pauses hidden sampling, and releases on disconnect", async () => {
  vi.useFakeTimers();
  const sampleScene = vi.fn(() => ({
    source: null,
    scene: null,
    controls: {},
    background: "#141619",
    renderer: {
      toneMapping: 0,
      toneMappingExposure: 1,
      outputColorSpace: "srgb",
      shadowMapEnabled: false,
      shadowMapType: 1,
    },
  }));
  const sampleMotion = vi.fn(() => null);
  const transport = {
    begin: vi.fn(async () => "lease"),
    open: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    publish: vi.fn(async (_frame: RemoteCallWindowFrame) => {}),
    listen: vi.fn(async () => vi.fn()),
    avatar: vi.fn(async () => {}),
    scene: vi.fn(async () => 1),
  };
  let source: RemoteCallWindowModel = {
    ...model(),
    visible: false,
    sampleScene,
    sampleMotion,
  };
  const host = new RemoteCallWindowHost(source, vi.fn(), transport);
  host.updateModel(source);
  await vi.advanceTimersByTimeAsync(100);
  expect(transport.begin).not.toHaveBeenCalled();

  source = { ...source, visible: true };
  host.updateModel(source);
  await vi.advanceTimersByTimeAsync(100);
  expect(transport.begin).toHaveBeenCalledOnce();
  expect(transport.open).toHaveBeenCalledOnce();
  expect(transport.scene).toHaveBeenCalledOnce();

  source = { ...source, mode: "portrait" };
  host.updateModel(source);
  await vi.advanceTimersByTimeAsync(100);
  expect(transport.begin).toHaveBeenCalledOnce();
  expect(transport.publish.mock.lastCall?.[0]).toMatchObject({
    mode: "portrait",
    visible: true,
  });

  source = { ...source, visible: false };
  host.updateModel(source);
  await vi.advanceTimersByTimeAsync(100);
  expect(transport.revoke).not.toHaveBeenCalled();
  expect(transport.publish.mock.lastCall?.[0]).toMatchObject({
    visible: false,
    motion: null,
    mouth: [0, 0, 0, 0, 0],
  });
  const hiddenCounts = [
    transport.publish.mock.calls.length,
    sampleMotion.mock.calls.length,
    sampleScene.mock.calls.length,
  ];
  await vi.advanceTimersByTimeAsync(1_000);
  expect([
    transport.publish.mock.calls.length,
    sampleMotion.mock.calls.length,
    sampleScene.mock.calls.length,
  ]).toEqual(hiddenCounts);

  source = { ...source, mode: "call", visible: true };
  host.updateModel(source);
  await vi.advanceTimersByTimeAsync(100);
  expect(transport.begin).toHaveBeenCalledOnce();
  expect(transport.open).toHaveBeenCalledOnce();
  expect(transport.scene).toHaveBeenCalledOnce();
  expect(transport.publish.mock.lastCall?.[0]).toMatchObject({ visible: true, mode: "call" });
  sampleScene.mockReturnValue({ ...sampleScene(), background: "#334455" });
  await vi.advanceTimersByTimeAsync(100);
  expect(transport.scene).toHaveBeenCalledTimes(2);

  source = { ...source, ownerKey: null, visible: false };
  host.updateModel(source);
  await vi.advanceTimersByTimeAsync(0);
  expect(transport.revoke).toHaveBeenCalledExactlyOnceWith("lease");
  host.dispose();
  await vi.advanceTimersByTimeAsync(0);
});

it("coalesces scene settings separately from motion and sends the newest controls after a pending upload", async () => {
  vi.useFakeTimers();
  let controls = { "lights.fill": 0.4 };
  const sampleScene = vi.fn(() => ({
    source: null,
    scene: null,
    controls,
    background: "#141619",
    renderer: {
      toneMapping: 0,
      toneMappingExposure: 1,
      outputColorSpace: "srgb",
      shadowMapEnabled: false,
      shadowMapType: 1,
    },
  }));
  const source = { ...model(), sampleScene };
  let finish!: (revision: number) => void;
  const upload = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const publish = vi.fn(async () => {});
  const stop = startRemoteCallRelay(
    () => source,
    "lease",
    publish,
    vi.fn(),
    vi.fn(),
    undefined,
    upload,
  );
  await vi.advanceTimersByTimeAsync(300);
  expect(upload).toHaveBeenCalledOnce();
  expect(publish.mock.calls.length).toBeGreaterThan(3);
  controls = { "lights.fill": 1.2 };
  finish(1);
  await vi.advanceTimersByTimeAsync(110);
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.lastCall).toEqual(["lease", sampleScene()]);
  finish(2);
  await vi.advanceTimersByTimeAsync(300);
  expect(upload).toHaveBeenCalledTimes(2);
  stop();
  controls = { "lights.fill": 2 };
  await vi.advanceTimersByTimeAsync(300);
  expect(upload).toHaveBeenCalledTimes(2);
});

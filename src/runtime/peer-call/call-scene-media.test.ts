// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CallSceneMediaPublisher, CallSceneMediaReceiver } from "./call-scene-media";
import type { CallSceneAppearance } from "./call-scene-state";

const id = "a345cd67-8aaf-4460-b4ea-123456789abc";
const appearance = (src: string): CallSceneAppearance => ({
  source: null,
  scene: { id: "test", layers: [{ id: "bg", src, mediaType: "image" }] },
  controls: {},
  background: "#123456",
  renderer: {
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: "srgb",
    shadowMapEnabled: false,
    shadowMapType: 1,
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("copies only a selected Blob once and creates an owned URL in the receiving WebView", async () => {
  const fetch = vi.fn(async () => ({
    blob: async () => ({
      type: "image/png",
      size: 3,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }),
  }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
  const upload = vi.fn(async () => {});
  const publisher = new CallSceneMediaPublisher(upload);
  const projected = await publisher.project(appearance("blob:main-owned"));
  await publisher.project({ ...appearance("blob:main-owned"), controls: { ambient: 0.8 } });
  expect(upload).toHaveBeenCalledExactlyOnceWith(id, "image/png", "AQID");
  expect(projected.scene?.layers[0].src).toBe(`yorishiro-call-media:${id}`);
  const create = vi.fn(() => "blob:receiver-owned");
  const revoke = vi.fn();
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  const read = vi.fn(async () => ({ encoded: "AQID", mime: "image/png" }));
  const receiver = new CallSceneMediaReceiver(read);
  expect((await receiver.project(projected)).scene?.layers[0].src).toBe("blob:receiver-owned");
  await receiver.project(projected);
  expect(read).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("blob:main-owned");
  receiver.dispose();
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledWith("blob:receiver-owned");
});
it("never fetches bundled/local asset URLs or forwards HTML as background media", async () => {
  const fetch = vi.fn(async () => ({ blob: async () => ({ type: "text/html", size: 10 }) }));
  vi.stubGlobal("fetch", fetch);
  const upload = vi.fn(async () => {});
  const publisher = new CallSceneMediaPublisher(upload);
  await publisher.project(appearance("asset://localhost/background.png"));
  expect(fetch).not.toHaveBeenCalled();
  await expect(publisher.project(appearance("blob:html"))).rejects.toThrow();
  expect(upload).not.toHaveBeenCalled();
});
it("does not create media URLs after the presentation lease closes", async () => {
  let finish!: (value: { encoded: string; mime: string }) => void;
  const create = vi.fn();
  URL.createObjectURL = create;
  const receiver = new CallSceneMediaReceiver(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const projected = receiver.project(appearance(`yorishiro-call-media:${id}`));
  receiver.dispose();
  finish({ encoded: "AQID", mime: "image/png" });
  await expect(projected).rejects.toThrow("closed");
  expect(create).not.toHaveBeenCalled();
});

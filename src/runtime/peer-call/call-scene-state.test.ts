// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entry: vi.fn(),
  scene: vi.fn(),
  controls: vi.fn(),
  renderer: vi.fn(),
}));
vi.mock("../scene-pack-registry", () => ({
  getSceneRegistry: () => ({ getActiveEntry: state.entry }),
}));
vi.mock("../../core/scene/scene-layer-bridge", () => ({
  getSceneLayerBridge: () => ({ getScene: state.scene }),
}));
vi.mock("../three-runtime/scene-pack-leva-store", () => ({
  getActiveSceneLevaStore: () => ({ getData: state.controls }),
}));
vi.mock("../three-runtime/three-runtime", () => ({
  getThreeRuntime: () => ({ getRenderer: state.renderer }),
}));

import { sampleCallScene } from "./call-scene-state";

it("copies the final local scene and light values without exporting callbacks, ambient audio or terminal configuration", () => {
  state.entry.mockReturnValue({ id: "room", origin: "bundled", scene: { id: "room", layers: [] } });
  state.scene.mockReturnValue({
    id: "room",
    layers: [{ id: "bg", backgroundColor: "#456789" }],
    ambient: [{ src: "private-audio" }],
    terminal: { foreground: "#123456" },
  });
  state.controls.mockReturnValue({
    "lights.ambient": { value: 0.7, onChange: () => {} },
    "lights.color": { value: "#ffeedd" },
    button: { value: () => {} },
  });
  state.renderer.mockReturnValue({
    toneMapping: 4,
    toneMappingExposure: 1.2,
    outputColorSpace: "srgb",
    shadowMap: { enabled: true, type: 2 },
  });
  const first = sampleCallScene();
  expect(first.scene).toEqual({ id: "room", layers: [{ id: "bg", backgroundColor: "#456789" }] });
  expect(first.controls).toEqual({ "lights.ambient": 0.7, "lights.color": "#ffeedd" });
  expect(first.renderer.toneMappingExposure).toBe(1.2);
  expect(sampleCallScene().source).toEqual(first.source);
  state.scene.mockReturnValue({ id: "previous-scene", layers: [{ id: "stale" }] });
  expect(sampleCallScene().scene?.layers).toEqual([]);
});

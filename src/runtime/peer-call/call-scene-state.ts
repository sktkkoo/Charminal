import { getSceneLayerBridge } from "../../core/scene/scene-layer-bridge";
import type { SceneSpec } from "../../sdk/scene";
import { getSceneRegistry } from "../scene-pack-registry";
import { getActiveSceneLevaStore } from "../three-runtime/scene-pack-leva-store";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import { type CallSceneSource, callSceneSource } from "./call-scene-source";

/** Main-to-own-window appearance. This is never part of the peer/network protocol. */
export interface CallSceneAppearance {
  source: CallSceneSource | null;
  scene: Pick<SceneSpec, "id" | "layers" | "ui"> | null;
  controls: Record<string, unknown>;
  renderer: {
    toneMapping: number;
    toneMappingExposure: number;
    outputColorSpace: string;
    shadowMapEnabled: boolean;
    shadowMapType: number;
  };
  background: string;
}

/** Copy values only: callbacks, schemas, audio, persona and terminal state stay in main. */
export function sceneControlValues(data: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [path, input] of Object.entries(data)) {
    if (!input || typeof input !== "object" || !("value" in input)) continue;
    const encoded = JSON.stringify(input.value);
    if (encoded !== undefined) values[path] = JSON.parse(encoded);
  }
  return values;
}

export function sampleCallScene(): CallSceneAppearance {
  const entry = getSceneRegistry().getActiveEntry();
  const overridden = getSceneLayerBridge()?.getScene();
  const scene = overridden?.id === entry?.id ? overridden : entry?.scene;
  const renderer = getThreeRuntime().getRenderer();
  const data = getActiveSceneLevaStore()?.getData() ?? {};
  return {
    source: entry ? callSceneSource(entry) : null,
    scene: scene
      ? { id: scene.id, layers: scene.layers, ...(scene.ui ? { ui: scene.ui } : {}) }
      : null,
    controls: sceneControlValues(data),
    renderer: {
      toneMapping: renderer.toneMapping,
      toneMappingExposure: renderer.toneMappingExposure,
      outputColorSpace: renderer.outputColorSpace,
      shadowMapEnabled: renderer.shadowMap.enabled,
      shadowMapType: renderer.shadowMap.type,
    },
    background:
      getComputedStyle(document.documentElement).getPropertyValue("--yorishiro-bg").trim() ||
      "#141619",
  };
}

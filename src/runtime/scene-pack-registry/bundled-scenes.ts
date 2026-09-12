import abandonedFactoryManifest from "../../../bundled-packs/scenes/abandoned-factory/manifest.json";
import abandonedFactoryPack from "../../../bundled-packs/scenes/abandoned-factory/scene";
import amberWindowManifest from "../../../bundled-packs/scenes/amber-window-room/manifest.json";
import amberWindowPack from "../../../bundled-packs/scenes/amber-window-room/scene";
import mistyGrasslandsManifest from "../../../bundled-packs/scenes/misty-grasslands/manifest.json";
import mistyGrasslandsPack from "../../../bundled-packs/scenes/misty-grasslands/scene";
import simpleRoomManifest from "../../../bundled-packs/scenes/simple-room/manifest.json";
import simpleRoomPack from "../../../bundled-packs/scenes/simple-room/scene";
import type { ScenePackDefinition, ScenePackManifest } from "../../sdk/scene-pack";

/** Scene-only imports: importing this list does not load personas, effects, or init.js. */
export const BUNDLED_SCENES: ReadonlyArray<{
  readonly pack: ScenePackDefinition;
  readonly manifest: ScenePackManifest;
}> = [
  { pack: simpleRoomPack, manifest: simpleRoomManifest as ScenePackManifest },
  { pack: mistyGrasslandsPack, manifest: mistyGrasslandsManifest as ScenePackManifest },
  { pack: abandonedFactoryPack, manifest: abandonedFactoryManifest as ScenePackManifest },
  { pack: amberWindowPack, manifest: amberWindowManifest as ScenePackManifest },
];

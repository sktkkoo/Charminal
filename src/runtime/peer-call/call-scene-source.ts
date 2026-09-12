import type { ScenePackEntry } from "../scene-pack-registry/types";

/** Identifies the main window's locally selected pack, never a peer-supplied module. */
export interface CallSceneSource {
  readonly origin: "bundled" | "user";
  readonly id: string;
  readonly generation?: number;
}

const key = Symbol.for("yorishiro.call-scene-generations");
const host = globalThis as typeof globalThis & {
  [key]?: { entries: WeakMap<ScenePackEntry, number>; next: number };
};
const generations = host[key] ?? { entries: new WeakMap<ScenePackEntry, number>(), next: 0 };
host[key] = generations;

export function callSceneSource(entry: ScenePackEntry): CallSceneSource {
  let generation = generations.entries.get(entry);
  if (generation === undefined) {
    generation = ++generations.next;
    generations.entries.set(entry, generation);
  }
  return { origin: entry.origin, id: entry.id, generation };
}

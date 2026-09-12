import { describe, expect, it, vi } from "vitest";
import type { ScenePackEntry } from "../scene-pack-registry/types";
import type { UserPackEntry } from "../user-pack-loader/user-pack-loader";
import {
  type CallSceneLoaderDependencies,
  loadCallScene,
  loadUserCallScene,
} from "./call-scene-loader";
import { callSceneSource } from "./call-scene-source";

vi.mock("../scene-pack-registry/asset-resolver", async (original) => ({
  ...(await original<object>()),
  resolveSceneAssets: vi.fn(async (scene) => scene),
}));

const manifest = {
  id: "my-room",
  type: "scene",
  entry: "scene.tsx",
  version: "1.0.0",
  yorishiroVersion: "^0.7.0",
  executionClass: "trusted-main-thread-js",
};
const selected = { origin: "user", id: "my-room", generation: 2 } as const;
const context = { leaseId: "local-call", sceneRevision: 3 };

function dependencies() {
  const component = () => null;
  const entry: UserPackEntry = {
    id: "my-room",
    kind: "scene",
    entryPath: "/home/user/.yorishiro/packs/my-room/scene.tsx",
    source: "local",
    manifest,
  };
  const deps = {
    resolveUserEntry: vi.fn(async () => entry),
    readManifest: vi.fn(async (): Promise<unknown> => manifest),
    importModule: vi.fn(async () => ({
      default: {
        type: "scene",
        id: "my-room",
        scene: { id: "my-room", layers: [] },
        component,
      },
    })),
    convertFileSrc: (path: string) => `asset://localhost${path}`,
    executionEnvironment: { clientVersion: "0.7.7", platform: "macos" },
  } satisfies CallSceneLoaderDependencies;
  return { deps, component, entry };
}

describe("scene-only loading", () => {
  it("loads only the selected local scene and keeps its pack-scoped asset resolver", async () => {
    const { deps, component } = dependencies();
    const result = await loadUserCallScene(selected, context, deps);
    expect(deps.resolveUserEntry).toHaveBeenCalledWith(context);
    expect(deps.importModule).toHaveBeenCalledWith(
      "/home/user/.yorishiro/packs/my-room/scene.tsx",
      "local-call:2:0",
    );
    expect(result.component).toBe(component);
    expect(result.resolveAsset?.("./assets/room.glb")).toBe(
      "asset://localhost/home/user/.yorishiro/packs/my-room/assets/room.glb",
    );
    expect(() => result.resolveAsset?.("../persona.js")).toThrow("unsafe");
  });

  it("revalidates the current manifest before evaluating code", async () => {
    const { deps } = dependencies();
    deps.readManifest.mockResolvedValue({ ...manifest, executionClass: "isolated-js" });
    await expect(loadUserCallScene(selected, context, deps)).rejects.toThrow("not implemented");
    expect(deps.importModule).not.toHaveBeenCalled();
  });

  it("does not execute a community source as trusted scene code", async () => {
    const { deps, entry } = dependencies();
    deps.resolveUserEntry.mockResolvedValue({ ...entry, source: "community" });
    await expect(loadUserCallScene(selected, context, deps)).rejects.toThrow("only allowed");
    expect(deps.importModule).not.toHaveBeenCalled();
  });

  it.each([
    { id: "different-room" },
    { kind: "persona" },
    { entryPath: "/home/user/.yorishiro/packs/my-room/init.js" },
    { entryPath: "/home/user/.yorishiro/packs/my-room/../my-room/scene.tsx" },
  ])("rejects a resolver mismatch before reading or importing: %j", async (patch) => {
    const { deps, entry } = dependencies();
    deps.resolveUserEntry.mockResolvedValue({ ...entry, ...patch });
    await expect(loadUserCallScene(selected, context, deps)).rejects.toThrow("unavailable");
    expect(deps.readManifest).not.toHaveBeenCalled();
    expect(deps.importModule).not.toHaveBeenCalled();
  });

  it("does not continue reading after a stale native lease rejection", async () => {
    const { deps } = dependencies();
    deps.resolveUserEntry.mockRejectedValue(new Error("Scene source changed"));
    await expect(loadUserCallScene(selected, context, deps)).rejects.toThrow("source changed");
    expect(deps.readManifest).not.toHaveBeenCalled();
    expect(deps.importModule).not.toHaveBeenCalled();
  });

  it("requires a lease for user scenes and rejects arbitrary source paths", async () => {
    await expect(loadCallScene(selected)).rejects.toThrow("lease");
    await expect(loadCallScene({ origin: "bundled", id: "../scene" })).rejects.toThrow("Invalid");
  });

  it("keeps generation stable across samples and changes it on same-id replacement", () => {
    const entry = {
      id: "my-room",
      origin: "user",
      manifest,
      scene: { id: "my-room", layers: [] },
    } as ScenePackEntry;
    const first = callSceneSource(entry);
    expect(callSceneSource(entry)).toEqual(first);
    expect(callSceneSource({ ...entry }).generation).not.toBe(first.generation);
    expect(Object.keys(first).sort()).toEqual(["generation", "id", "origin"]);
  });
});

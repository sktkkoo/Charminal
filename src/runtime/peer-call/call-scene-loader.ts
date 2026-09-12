import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { version as clientVersion } from "../../../package.json";
import { validateScenePackDefinition, validateScenePackManifest } from "../../sdk/validators";
import { resolveSceneAssets } from "../scene-pack-registry/asset-resolver";
import { makeUserResolveAsset } from "../scene-pack-registry/asset-resolver-pack";
import type { ScenePackEntry } from "../scene-pack-registry/types";
import {
  normalizeClientPlatform,
  normalizePackManifestSummary,
  type PackExecutionEnvironment,
  validatePackExecutionPolicy,
} from "../user-pack-loader/pack-execution-policy";
import type { UserPackEntry } from "../user-pack-loader/user-pack-loader";
import type { CallSceneSource } from "./call-scene-source";

export interface CallSceneLoadContext {
  readonly leaseId: string;
  readonly sceneRevision: number;
}

export interface CallSceneLoaderDependencies {
  readonly resolveUserEntry: (
    context: CallSceneLoadContext,
  ) => Promise<(UserPackEntry & { readonly modifiedAt?: number }) | null>;
  readonly readManifest: (entryPath: string) => Promise<unknown>;
  readonly importModule: (entryPath: string, cacheKey: string) => Promise<unknown>;
  readonly convertFileSrc: (path: string) => string;
  readonly executionEnvironment?: PackExecutionEnvironment;
}

function checkSource(source: CallSceneSource): void {
  if (
    (source.origin !== "bundled" && source.origin !== "user") ||
    !source.id ||
    source.id.length > 240 ||
    /[/\\:]/.test(source.id) ||
    source.id.includes(String.fromCharCode(0)) ||
    source.id.startsWith(".") ||
    (source.generation !== undefined &&
      (!Number.isSafeInteger(source.generation) || source.generation < 1))
  ) {
    throw new Error("Invalid local call scene source");
  }
}

/** Only the lease-bound native resolver may choose an installed scene entry. */
export async function loadUserCallScene(
  source: CallSceneSource,
  context: CallSceneLoadContext,
  deps: CallSceneLoaderDependencies,
): Promise<ScenePackEntry> {
  checkSource(source);
  if (source.origin !== "user") throw new Error("Expected a local user scene");
  const entry = await deps.resolveUserEntry(context);
  const path = entry?.entryPath;
  const segments = path?.replace(/\\/g, "/").split("/") ?? [];
  if (
    !entry ||
    entry.id !== source.id ||
    entry.kind !== "scene" ||
    !path ||
    !/^(?:\/|[A-Za-z]:[\\/])/.test(path) ||
    segments.some((part) => part === "." || part === "..") ||
    segments[segments.length - 2] !== source.id ||
    !/^scene\.(?:js|tsx)$/.test(segments[segments.length - 1] ?? "")
  ) {
    throw new Error("Selected local scene entry is unavailable");
  }
  // Revalidate the current manifest before module evaluation, including execution policy.
  const rawManifest = await deps.readManifest(path);
  const manifest = validateScenePackManifest(rawManifest, source.id);
  const policyError = validatePackExecutionPolicy(
    { ...entry, manifest: normalizePackManifestSummary(rawManifest) },
    deps.executionEnvironment,
  );
  if (policyError) throw new Error(policyError);
  const cacheKey = `${context.leaseId}:${source.generation ?? 0}:${entry.modifiedAt ?? 0}`;
  const module = await deps.importModule(path, cacheKey);
  const definition = validateScenePackDefinition(
    module && typeof module === "object" && "default" in module ? module.default : module,
  );
  const packDir = path.replace(/[/\\]scene\.(?:js|tsx)$/, "");
  return {
    id: source.id,
    origin: "user",
    manifest,
    scene: await resolveSceneAssets(definition.scene, {
      origin: "user",
      packId: source.id,
      packDir,
    }),
    component: definition.component,
    resolveAsset: makeUserResolveAsset(packDir, deps.convertFileSrc),
  };
}

export async function loadCallScene(
  source: CallSceneSource,
  context?: CallSceneLoadContext,
): Promise<ScenePackEntry> {
  checkSource(source);
  if (source.origin === "bundled") {
    const { BUNDLED_SCENES } = await import("../scene-pack-registry/bundled-scenes");
    const found = BUNDLED_SCENES.find(({ pack }) => pack.id === source.id);
    if (!found) throw new Error(`Bundled scene '${source.id}' is unavailable`);
    return {
      id: source.id,
      origin: "bundled",
      manifest: found.manifest,
      component: found.pack.component,
      scene: await resolveSceneAssets(found.pack.scene, { origin: "bundled", packId: source.id }),
    };
  }
  if (!context) throw new Error("A current call scene lease is required");
  const platform = normalizeClientPlatform(navigator.platform);
  return loadUserCallScene(source, context, {
    resolveUserEntry: (selection) => invoke("remote_call_window_scene_entry", { ...selection }),
    readManifest: async (entryPath) => {
      const manifestPath = entryPath.replace(/[/\\]scene\.(?:js|tsx)$/, "/manifest.json");
      const response = await fetch(convertFileSrc(manifestPath), { cache: "no-store" });
      if (!response.ok) throw new Error(`Scene manifest unavailable (HTTP ${response.status})`);
      return response.json();
    },
    importModule: async (entryPath, cacheKey) => {
      const { installPackHostGlobals } = await import("../user-pack-loader/pack-host-globals");
      installPackHostGlobals();
      if (entryPath.endsWith(".tsx")) {
        const { importUiTsxEntry } = await import("../user-pack-loader/tsx-transpiler");
        return importUiTsxEntry(entryPath, { convertFileSrc }, { cacheKey });
      }
      const url = `${convertFileSrc(entryPath)}?v=${encodeURIComponent(cacheKey)}`;
      return import(/* @vite-ignore */ url);
    },
    convertFileSrc,
    executionEnvironment: platform ? { clientVersion, platform } : undefined,
  });
}

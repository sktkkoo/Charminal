import { invoke } from "@tauri-apps/api/core";
import type { CallSceneAppearance } from "./call-scene-state";

const PREFIX = "yorishiro-call-media:";
const MAX_BYTES = 64 * 1024 * 1024;
const MIME =
  /^(?:image\/(?:png|jpeg|webp|gif|bmp|avif|svg\+xml)|video\/(?:mp4|webm|ogg|quicktime))$/;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return btoa(binary);
}

/** Main's Blob URLs are WebView-owned. Relay only selected image/video bytes to its own window. */
export class CallSceneMediaPublisher {
  private readonly sources = new Map<string, Promise<string>>();
  constructor(
    private readonly upload: (id: string, mime: string, encoded: string) => Promise<void>,
  ) {}

  async project(appearance: CallSceneAppearance): Promise<CallSceneAppearance> {
    const active = new Set(appearance.scene?.layers.map((layer) => layer.src));
    for (const src of this.sources.keys()) if (!active.has(src)) this.sources.delete(src);
    if (!appearance.scene) return appearance;
    const layers = await Promise.all(
      appearance.scene.layers.map(async (layer) => {
        if (!layer.src?.startsWith("blob:")) return layer;
        const src = layer.src;
        let projected = this.sources.get(src);
        if (!projected) {
          projected = (async () => {
            const blob = await (await fetch(src)).blob();
            if (!MIME.test(blob.type) || blob.size > MAX_BYTES || blob.size === 0) {
              throw new Error("通話ウィンドウの背景には64MB以下の画像または動画を選んでください。");
            }
            const id = crypto.randomUUID();
            await this.upload(id, blob.type, encode(new Uint8Array(await blob.arrayBuffer())));
            return `${PREFIX}${id}`;
          })();
          this.sources.set(src, projected);
          projected.catch(() => {
            if (this.sources.get(src) === projected) this.sources.delete(src);
          });
        }
        return { ...layer, src: await projected };
      }),
    );
    return { ...appearance, scene: { ...appearance.scene, layers } };
  }
}

const publishers = new Map<string, CallSceneMediaPublisher>();
export async function publishCallScene(
  leaseId: string,
  scene: CallSceneAppearance,
): Promise<number> {
  let publisher = publishers.get(leaseId);
  if (!publisher) {
    publisher = new CallSceneMediaPublisher((id, mime, encoded) =>
      invoke("remote_call_window_media", { leaseId, id, mime, encoded }),
    );
    publishers.set(leaseId, publisher);
  }
  return invoke("remote_call_window_scene", { leaseId, scene: await publisher.project(scene) });
}
export function releaseCallScenePublisher(leaseId: string): void {
  publishers.delete(leaseId);
}

/** Every displayed Blob belongs to this WebView and is revoked with the presentation lease. */
export class CallSceneMediaReceiver {
  private readonly urls = new Map<string, Promise<string>>();
  private disposed = false;
  private projection = 0;
  constructor(private readonly read: (id: string) => Promise<{ encoded: string; mime: string }>) {}
  async project(appearance: CallSceneAppearance): Promise<CallSceneAppearance> {
    const projection = ++this.projection;
    if (!appearance.scene) return appearance;
    const layers = await Promise.all(
      appearance.scene.layers.map(async (layer) => {
        if (!layer.src?.startsWith(PREFIX)) return layer;
        const id = layer.src.slice(PREFIX.length);
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid scene media reference");
        let url = this.urls.get(id);
        if (!url) {
          url = this.read(id).then(({ encoded, mime }) => {
            if (this.disposed) throw new Error("Scene view closed");
            if (!MIME.test(mime) || encoded.length > Math.ceil(MAX_BYTES / 3) * 4)
              throw new Error("Invalid scene media");
            const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
            return URL.createObjectURL(new Blob([bytes], { type: mime }));
          });
          this.urls.set(id, url);
          url.catch(() => {
            if (this.urls.get(id) === url) this.urls.delete(id);
          });
        }
        return { ...layer, src: await url };
      }),
    );
    if (!this.disposed && projection === this.projection) {
      const active = new Set(
        appearance.scene.layers.map((layer) =>
          layer.src?.startsWith(PREFIX) ? layer.src.slice(PREFIX.length) : undefined,
        ),
      );
      for (const [id, url] of this.urls)
        if (!active.has(id)) {
          this.urls.delete(id);
          void url.then(
            (value) => URL.revokeObjectURL(value),
            () => {},
          );
        }
    }
    return { ...appearance, scene: { ...appearance.scene, layers } };
  }
  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values())
      void url.then(
        (value) => URL.revokeObjectURL(value),
        () => {},
      );
    this.urls.clear();
  }
}
export function createCallSceneMediaReceiver(leaseId: string): CallSceneMediaReceiver {
  return new CallSceneMediaReceiver((id) =>
    invoke("remote_call_window_read_media", { leaseId, id }),
  );
}

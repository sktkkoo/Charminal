/** URLs minted by this webview from its own received avatar bytes, never supplied by a peer. */
const issuedAvatarUrls = new Set<string>();

/**
 * This records ownership, not file validity. AvatarTransfer and the receiving renderer
 * independently preflight the GLB before it can be parsed. Native Tauri has an opaque
 * URL origin, so URL.origin comparisons cannot establish local blob ownership there.
 */
export function createCallAvatarUrl(bytes: ArrayBuffer): string {
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > 32 * 1024 * 1024
  )
    throw new Error("Invalid call avatar bytes");
  const url = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
  issuedAvatarUrls.add(url);
  return url;
}

export function isIssuedCallAvatarUrl(value: string): boolean {
  return issuedAvatarUrls.has(value);
}

export function revokeCallAvatarUrl(value: string): void {
  if (issuedAvatarUrls.delete(value)) URL.revokeObjectURL(value);
}

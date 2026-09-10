export type MediaPermissionKind = "camera" | "microphone" | "screen";

export function mediaPermissionError(error: unknown, kind: "camera" | "microphone"): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")
  ) {
    const denied = new Error(`${kind === "camera" ? "Camera" : "Microphone"} permission denied.`);
    denied.name = "NotAllowedError";
    throw denied;
  }
  throw error;
}

/** Match only capture-permission errors, not unrelated network/auth failures. */
export function getMediaPermissionKind(error?: string): MediaPermissionKind | undefined {
  if (!error) return undefined;
  if (error.includes("Camera permission denied.")) return "camera";
  if (error.includes("Microphone permission denied.")) return "microphone";
  if (/Screen (Recording permission is required|recording permission is not granted)/i.test(error))
    return "screen";
  return undefined;
}

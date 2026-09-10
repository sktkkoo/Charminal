// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MediaPermissionHelp } from "./media-permission-help";
import { getMediaPermissionKind, mediaPermissionError } from "./runtime/media-permissions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset();
});
it.each([
  "camera",
  "microphone",
  "screen",
] as const)("opens only requested %s settings after an explicit click", async (kind) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(<MediaPermissionHelp kind={kind} language="ja" />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "システム設定を開く" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_media_permission_settings", { kind }),
  );
});
it("keeps manual instructions when settings fail to open", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.mocked(invoke).mockRejectedValue(new Error("failure"));
  render(<MediaPermissionHelp kind="camera" language="ja" />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByText(/設定を開けませんでした/)).toBeTruthy();
});
it("classifies actual capture denial but leaves device/network failures untouched", () => {
  for (const kind of ["camera", "microphone"] as const) {
    try {
      mediaPermissionError(new DOMException("denied", "NotAllowedError"), kind);
    } catch (error) {
      expect(getMediaPermissionKind(String(error))).toBe(kind);
    }
  }
  const deviceError = new DOMException("missing", "NotFoundError");
  expect(() => mediaPermissionError(deviceError, "camera")).toThrow(deviceError);
  expect(getMediaPermissionKind("network denied")).toBeUndefined();
  expect(getMediaPermissionKind("Screen recording permission is not granted.")).toBe("screen");
});

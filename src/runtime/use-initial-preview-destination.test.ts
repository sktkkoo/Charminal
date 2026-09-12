// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useInitialPreviewDestination } from "./use-initial-preview-destination";

afterEach(cleanup);
it("keeps an inline preview inline through mode and frame changes", () => {
  const detach = vi.fn(async () => {});
  const initialProps = { sessionKey: "a", ready: true, initiallyDetached: false, detach };
  const { rerender } = renderHook(useInitialPreviewDestination, { initialProps });
  rerender({ ...initialProps, initiallyDetached: true, ready: false });
  rerender({ ...initialProps, initiallyDetached: true });
  expect(detach).not.toHaveBeenCalled();
});
it("chooses compact placement at start, waits for the frame and never reopens it", () => {
  const detach = vi.fn(async () => {});
  const initialProps = { sessionKey: "a", ready: false, initiallyDetached: true, detach };
  const { rerender } = renderHook(useInitialPreviewDestination, { initialProps });
  rerender({ ...initialProps, initiallyDetached: false, ready: true });
  expect(detach).toHaveBeenCalledTimes(1);
  rerender({ ...initialProps, ready: false });
  rerender({ ...initialProps, ready: true });
  expect(detach).toHaveBeenCalledTimes(1);
  rerender({ ...initialProps, sessionKey: "b", ready: true });
  expect(detach).toHaveBeenCalledTimes(2);
});

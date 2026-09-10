// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { withoutInlineScreenPreview } from "./screen-preview-capture";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("restores inline visibility after failed capture even when animation frames are suspended", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = "<section data-screen-preview-inline></section>";
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  const capture = vi.fn(async () => {
    throw new Error("failed");
  });
  const operation = withoutInlineScreenPreview(capture, new AbortController().signal);
  const rejected = expect(operation).rejects.toThrow("failed");
  expect(document.documentElement.hasAttribute("data-screen-capturing")).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(capture).toHaveBeenCalledOnce();
  expect(document.documentElement.hasAttribute("data-screen-capturing")).toBe(false);
});
it("cancellation during paint wait prevents native capture and restores visibility", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = "<section data-screen-preview-inline></section>";
  const controller = new AbortController();
  const capture = vi.fn(async () => 1);
  const operation = withoutInlineScreenPreview(capture, controller.signal);
  const rejected = expect(operation).rejects.toThrow();
  controller.abort();
  await rejected;
  expect(capture).not.toHaveBeenCalled();
  expect(document.documentElement.hasAttribute("data-screen-capturing")).toBe(false);
});

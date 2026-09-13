// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallDebugPanel } from "./use-call-debug-panel";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function panel(initialHidden = true, initiallyActive = false) {
  const frames: { callActive: boolean; storedHidden: boolean; visible: boolean }[] = [];
  const hook = renderHook(
    ({ callActive }) => {
      const [hidden, setHidden] = useState(initialHidden);
      const controls = useCallDebugPanel({ callActive, hidden, setHidden });
      frames.push({ callActive, storedHidden: hidden, visible: !controls.hidden });
      return { ...controls, storedHidden: hidden, externalSetHidden: setHidden };
    },
    { initialProps: { callActive: initiallyActive } },
  );
  return { ...hook, frames };
}

describe("debug panel during calls", () => {
  it("toggles normally outside calls without showing a restriction notice", () => {
    const hook = panel();
    act(() => hook.result.current.toggle());
    expect(hook.result.current.hidden).toBe(false);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.hidden).toBe(true);
    expect(hook.result.current.showNotice).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an open panel from the first call render and leaves it closed after the call", () => {
    const hook = panel(false);
    expect(hook.result.current.hidden).toBe(false);
    hook.rerender({ callActive: true });
    const activeFrames = hook.frames.filter((frame) => frame.callActive);
    expect(activeFrames[0].storedHidden).toBe(false);
    expect(activeFrames.every((frame) => !frame.visible)).toBe(true);
    expect(hook.result.current.storedHidden).toBe(true);
    expect(hook.result.current.showNotice).toBe(false);
    hook.rerender({ callActive: false });
    expect(hook.result.current.hidden).toBe(true);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.hidden).toBe(false);
  });

  it("also closes programmatic open requests during a call without a visible frame", () => {
    const hook = panel(true, true);
    act(() => hook.result.current.externalSetHidden(false));
    expect(hook.frames.some((frame) => !frame.storedHidden)).toBe(true);
    expect(hook.frames.every((frame) => !frame.visible)).toBe(true);
    expect(hook.result.current.storedHidden).toBe(true);
    expect(hook.result.current.showNotice).toBe(false);
    hook.rerender({ callActive: false });
    expect(hook.result.current.hidden).toBe(true);
  });

  it("keeps the panel closed and restarts the four-second notice on repeated F2 requests", () => {
    const hook = panel(true, true);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.showNotice).toBe(true);
    act(() => vi.advanceTimersByTime(3_000));
    act(() => hook.result.current.toggle());
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(3_999));
    expect(hook.result.current.showNotice).toBe(true);
    expect(hook.result.current.hidden).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.showNotice).toBe(false);
    expect(hook.result.current.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a pending notice when the call ends and does not carry it into the next call", () => {
    const hook = panel(true, true);
    act(() => hook.result.current.toggle());
    hook.rerender({ callActive: false });
    expect(hook.result.current.showNotice).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    hook.rerender({ callActive: true });
    expect(hook.result.current.showNotice).toBe(false);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.showNotice).toBe(true);
  });

  it("cancels the notice timer on unmount", () => {
    const hook = panel(true, true);
    act(() => hook.result.current.toggle());
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

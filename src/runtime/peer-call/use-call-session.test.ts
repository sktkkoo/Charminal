// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDestroy } from "../../bindings/tauri-commands";
import { SessionTabManager } from "../session-tabs/session-tab-manager";
import { disposeTerminalRuntime } from "../terminal-runtime";
import { useCallSession } from "./use-call-session";

vi.mock("../../bindings/tauri-commands", () => ({
  sessionDestroy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../terminal-runtime", () => ({
  disposeTerminalRuntime: vi.fn(),
  getTerminalRuntime: vi.fn(),
}));

const MAIN = "default-session";
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("call-only session ownership", () => {
  it("switches before admission and idempotently releases only the matching call", () => {
    const manager = new SessionTabManager(MAIN);
    const work = manager.openShell("/work/private");
    const onCloseRequested = vi.fn();
    const hook = renderHook(() => useCallSession(manager, { onCloseRequested }));
    let firstId = "";
    act(() => {
      firstId = hook.result.current.begin("room-one");
      expect(manager.getState().activeSessionId).toBe(firstId);
      expect(hook.result.current.begin("room-one")).toBe(firstId);
      expect(() => hook.result.current.begin("room-two")).toThrow("already open");
      hook.result.current.end("room-two");
    });
    expect(hook.result.current.sessionId).toBe(firstId);
    act(() => hook.result.current.end("room-one"));
    expect(hook.result.current.sessionId).toBeNull();
    expect(manager.getState().activeSessionId).toBe(work);
    expect(onCloseRequested).not.toHaveBeenCalled();
    expect(sessionDestroy).not.toHaveBeenCalled();
    expect(disposeTerminalRuntime).not.toHaveBeenCalled();
    act(() => {
      expect(hook.result.current.begin("room-two")).not.toBe(firstId);
      hook.result.current.end("room-one");
    });
    expect(hook.result.current.sessionId).not.toBeNull();
  });

  it("a manual tab switch keeps the call alive and end preserves that focus", () => {
    const manager = new SessionTabManager(MAIN);
    const onCloseRequested = vi.fn();
    const hook = renderHook(() => useCallSession(manager, { onCloseRequested }));
    act(() => hook.result.current.begin("room"));
    const callId = hook.result.current.sessionId;
    let newWork = "";
    act(() => {
      newWork = manager.openShell("/work/another");
      expect(hook.result.current.begin("room")).toBe(callId);
    });
    expect(manager.getState().activeSessionId).toBe(newWork);
    expect(hook.result.current.sessionId).toBe(callId);
    act(() => hook.result.current.end());
    expect(manager.getState().activeSessionId).toBe(newWork);
    expect(onCloseRequested).not.toHaveBeenCalled();
  });

  it("closing the call tab requests leave once using the latest callback", () => {
    const manager = new SessionTabManager(MAIN);
    const original = manager.openShell("/work/original");
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const hook = renderHook(
      ({ onCloseRequested }) => useCallSession(manager, { onCloseRequested }),
      {
        initialProps: { onCloseRequested: firstClose },
      },
    );
    act(() => hook.result.current.begin("room"));
    const callId = hook.result.current.sessionId as string;
    hook.rerender({ onCloseRequested: latestClose });
    act(() => {
      manager.close(callId);
      manager.close(callId);
      hook.result.current.end("room");
    });
    expect(hook.result.current.sessionId).toBeNull();
    expect(manager.getState().activeSessionId).toBe(original);
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledExactlyOnceWith("room");
    expect(sessionDestroy).not.toHaveBeenCalled();
  });

  it("unmount removes its own presentation without destroying or replacing work", () => {
    const manager = new SessionTabManager(MAIN);
    const original = manager.openShell("/work/original");
    const onCloseRequested = vi.fn();
    const hook = renderHook(() => useCallSession(manager, { onCloseRequested }));
    act(() => hook.result.current.begin("room"));
    hook.unmount();
    expect(manager.getState().sessions).toEqual([MAIN, original]);
    expect(manager.getState().activeSessionId).toBe(original);
    expect(sessionDestroy).not.toHaveBeenCalled();
    expect(disposeTerminalRuntime).not.toHaveBeenCalled();
    expect(onCloseRequested).not.toHaveBeenCalled();
  });

  it("setup failure propagates without media admission or focus change", () => {
    const manager = new SessionTabManager(MAIN);
    const hook = renderHook(() => useCallSession(manager, { onCloseRequested: vi.fn() }));
    const admit = vi.fn();
    vi.spyOn(manager, "openCallSession").mockImplementation(() => {
      throw new Error("setup failed");
    });
    expect(() => {
      hook.result.current.begin("room");
      admit();
    }).toThrow("setup failed");
    expect(admit).not.toHaveBeenCalled();
    expect(hook.result.current.sessionId).toBeNull();
    expect(manager.getState()).toMatchObject({ sessions: [MAIN], activeSessionId: MAIN });
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTerminalRuntime } from "../terminal-runtime";
import { SessionTabManager } from "./session-tab-manager";
import { getWorkTerminalRuntime, installCommandRunKeybindings } from "./terminal-session";

const terminal = vi.hoisted(() => ({
  attachLastFailedRun: vi.fn(),
  scrollToAdjacentCommandRun: vi.fn(),
}));
vi.mock("../../bindings/tauri-commands", () => ({ sessionDestroy: vi.fn() }));
vi.mock("../terminal-runtime", () => ({
  getTerminalRuntime: vi.fn(() => terminal),
  disposeTerminalRuntime: vi.fn(),
}));

let uninstall: (() => void) | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe("work terminal access from call UI", () => {
  it("never creates a runtime for a call tab, unknown ID, or recently closed call tab", () => {
    const manager = new SessionTabManager("work");
    const call = manager.openCallSession();
    expect(getWorkTerminalRuntime(manager, call)).toBeNull();
    expect(getWorkTerminalRuntime(manager, "unknown")).toBeNull();
    manager.closeCallSession(call);
    expect(getWorkTerminalRuntime(manager, call)).toBeNull();
    expect(getTerminalRuntime).not.toHaveBeenCalled();
    expect(getWorkTerminalRuntime(manager, "work")).toBe(terminal);
  });

  it("checks current ownership on keydown so shortcuts cannot instantiate a pending call terminal", () => {
    const manager = new SessionTabManager("work");
    uninstall = installCommandRunKeybindings(manager);
    const call = manager.openCallSession();
    for (const code of ["KeyF", "BracketRight", "BracketLeft"]) {
      const event = new KeyboardEvent("keydown", {
        code,
        metaKey: true,
        shiftKey: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(getTerminalRuntime).not.toHaveBeenCalled();
    manager.switchTo("work");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyF", ctrlKey: true, shiftKey: true }),
    );
    expect(getTerminalRuntime).toHaveBeenCalledExactlyOnceWith("work");
    expect(terminal.attachLastFailedRun).toHaveBeenCalledOnce();
    manager.switchTo(call);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "BracketRight", metaKey: true }));
    expect(getTerminalRuntime).toHaveBeenCalledOnce();
    expect(terminal.scrollToAdjacentCommandRun).not.toHaveBeenCalled();
  });
});

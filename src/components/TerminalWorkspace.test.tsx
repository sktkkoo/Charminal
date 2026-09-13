// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Perception } from "../core/perception";
import TerminalWorkspace from "./TerminalWorkspace";

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn(), activate: vi.fn() }));
vi.mock("../terminal", () => ({
  default: ({
    sessionId,
    visible,
    active,
    perception,
    onActivate,
  }: {
    sessionId: string;
    visible: boolean;
    active: boolean;
    perception: unknown;
    onActivate(id: string): void;
  }) => {
    useEffect(() => {
      lifecycle.mount(sessionId);
      return () => lifecycle.unmount(sessionId);
    }, [sessionId]);
    return (
      <button
        type="button"
        data-testid={sessionId}
        data-visible={String(visible)}
        data-active={String(active)}
        data-perception={perception ? "present" : "none"}
        onClick={() => onActivate(sessionId)}
      >
        {sessionId}
      </button>
    );
  },
}));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("TerminalWorkspace call presentation", () => {
  it("keeps every work terminal mounted but inactive while call UI occupies the workspace", () => {
    const getSpec = vi.fn(() => ({ kind: "shell" as const, command: "shell" }));
    const props = {
      sessions: ["work", "shell-1"],
      activeSessionId: "work",
      cwd: "/work",
      getSessionCwd: () => undefined,
      getSpec,
      getInterruptProtectionMode: () => "none" as const,
      perception: {} as Perception,
      shouldAttachExistingSession: () => true,
      onActivate: lifecycle.activate,
    };
    const view = render(<TerminalWorkspace {...props} />);
    const originalWork = screen.getByTestId("work");
    expect(lifecycle.mount.mock.calls).toEqual([["work"], ["shell-1"]]);
    view.rerender(
      <TerminalWorkspace {...props} activeSessionId="call-fresh">
        <section>Call only</section>
      </TerminalWorkspace>,
    );
    expect(screen.getByText("Call only")).toBeTruthy();
    expect(screen.getByTestId("work")).toBe(originalWork);
    for (const id of props.sessions) {
      expect(screen.getByTestId(id).getAttribute("data-visible")).toBe("false");
      expect(screen.getByTestId(id).getAttribute("data-active")).toBe("false");
      expect(screen.getByTestId(id).getAttribute("data-perception")).toBe("none");
    }
    expect(lifecycle.unmount).not.toHaveBeenCalled();
    expect(getSpec.mock.calls.flat()).not.toContain("call-fresh");
    view.rerender(<TerminalWorkspace {...props} />);
    expect(screen.getByTestId("work")).toBe(originalWork);
    expect(screen.getByTestId("work").getAttribute("data-active")).toBe("true");
    expect(lifecycle.mount).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("work"));
    expect(lifecycle.activate).toHaveBeenCalledWith("work");
  });
});

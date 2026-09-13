// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallSessionView } from "./call-session-view";
import type { RoomCall } from "./room-call";

afterEach(cleanup);

describe("CallSessionView", () => {
  it("allows cancellation during setup and disables chat before admission", () => {
    const onEnd = vi.fn();
    render(<CallSessionView room={null} language="en" onChat={vi.fn()} onEnd={onEnd} />);
    expect(screen.getByText("Waiting for the call to connect.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Call session" }));
    expect(
      (screen.getByRole("button", { name: "Talk to both residents" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("renders only the supplied call transcript and sends chat/end through call callbacks", () => {
    const onChat = vi.fn();
    const onEnd = vi.fn();
    const room = {
      connected: true,
      transcripts: [{ id: "one", speaker: "Mai", text: "Hello, Yori" }],
    } as unknown as RoomCall;
    render(<CallSessionView room={room} language="en" onChat={onChat} onEnd={onEnd} />);
    expect(screen.getByRole("log").textContent).toBe("MaiHello, Yori");
    fireEvent.click(screen.getByRole("button", { name: "Talk to both residents" }));
    expect(onChat).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });
});

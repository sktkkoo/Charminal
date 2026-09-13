// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallSessionView } from "./call-session-view";
import type { RoomCall, RoomCallTranscript } from "./room-call";

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
      transcripts: [
        { id: "one", speaker: "Mai", text: "Hello, Yori", origin: "remote", role: "assistant" },
      ],
    } as unknown as RoomCall;
    render(<CallSessionView room={room} language="en" onChat={onChat} onEnd={onEnd} />);
    expect(screen.getByRole("log").textContent).toBe("MaiAIHello, Yori");
    fireEvent.click(screen.getByRole("button", { name: "Talk to both residents" }));
    expect(onChat).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("keeps each human and AI on their endpoint's side even when resident names match", () => {
    const transcripts: RoomCallTranscript[] = [
      { id: "1", speaker: "Yori", text: "Local AI", origin: "local", role: "assistant" },
      { id: "2", speaker: "Yori", text: "Remote AI", origin: "remote", role: "assistant" },
      { id: "3", speaker: "あなた", text: "Local human", origin: "local", role: "user" },
      { id: "4", speaker: "相手のユーザー", text: "Remote human", origin: "remote", role: "user" },
    ];
    const room = { connected: true, transcripts } as unknown as RoomCall;
    render(<CallSessionView room={room} language="en" onChat={vi.fn()} onEnd={vi.fn()} />);
    const messages = [...screen.getByRole("log").querySelectorAll(".call-session-message")];
    expect(messages.map((message) => message.getAttribute("data-origin"))).toEqual([
      "local",
      "remote",
      "local",
      "remote",
    ]);
    expect(messages.map((message) => message.getAttribute("data-speaker-role"))).toEqual([
      "assistant",
      "assistant",
      "user",
      "user",
    ]);
    expect(messages.map((message) => message.querySelector("p")?.textContent)).toEqual([
      "Local AI",
      "Remote AI",
      "Local human",
      "Remote human",
    ]);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Remote user")).toBeTruthy();
  });

  it("follows new messages only while the reader is near the latest message", () => {
    const room = { connected: true, transcripts: [] as RoomCallTranscript[] };
    const props = { language: "en", onChat: vi.fn(), onEnd: vi.fn() };
    const view = render(<CallSessionView {...props} room={room as unknown as RoomCall} />);
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 300, configurable: true },
    });
    const append = (id: string) => {
      room.transcripts = [
        ...room.transcripts,
        { id, speaker: "Yori", text: id, origin: "local", role: "assistant" },
      ];
      view.rerender(<CallSessionView {...props} room={room as unknown as RoomCall} />);
    };
    append("1");
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 200;
    fireEvent.scroll(log);
    append("2");
    expect(log.scrollTop).toBe(200);
    log.scrollTop = 690;
    fireEvent.scroll(log);
    append("3");
    expect(log.scrollTop).toBe(1000);
  });
});

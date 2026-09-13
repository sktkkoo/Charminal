// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallSessionView } from "./call-session-view";
import type { RoomCall, RoomCallTranscript } from "./room-call";

afterEach(cleanup);

function composerProps() {
  return { draft: "", onDraftChange: vi.fn(), onSubmit: vi.fn(), sending: false };
}

describe("CallSessionView", () => {
  it("allows cancellation during setup and disables chat before admission", () => {
    const onEnd = vi.fn();
    render(<CallSessionView {...composerProps()} room={null} language="en" onEnd={onEnd} />);
    expect(screen.getByText("Waiting for the call to connect.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Call session" }));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("renders only the supplied call transcript and sends chat/end through call callbacks", () => {
    const onSubmit = vi.fn();
    const onEnd = vi.fn();
    const room = {
      connected: true,
      ready: true,
      transcripts: [
        { id: "one", speaker: "Mai", text: "Hello, Yori", origin: "remote", role: "assistant" },
      ],
    } as unknown as RoomCall;
    render(
      <CallSessionView
        {...composerProps()}
        draft="Hello"
        room={room}
        language="en"
        onSubmit={onSubmit}
        onEnd={onEnd}
      />,
    );
    expect(screen.getByRole("log").textContent).toBe("MaiAIHello, Yori");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledOnce();
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
    render(<CallSessionView {...composerProps()} room={room} language="en" onEnd={vi.fn()} />);
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
    const props = { ...composerProps(), language: "en", onEnd: vi.fn() };
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

  it("submits only Ctrl+Enter or Send, preserving plain Enter and IME composition", () => {
    const room = { connected: true, ready: true, transcripts: [] } as unknown as RoomCall;
    const props = { ...composerProps(), draft: "Hello", room, language: "en", onEnd: vi.fn() };
    render(<CallSessionView {...props} />);
    const textarea = screen.getByRole("textbox");
    expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "Enter", metaKey: true })).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, keyCode: 229 });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.compositionEnd(textarea);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, repeat: true });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it("keeps the scoped draft editable while waiting and gates submission on readiness", () => {
    const room = { connected: true, ready: false, transcripts: [] };
    const props = {
      ...composerProps(),
      draft: "Draft",
      room: room as unknown as RoomCall,
      language: "en",
      onEnd: vi.fn(),
    };
    const view = render(<CallSessionView {...props} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(textarea.value).toBe("Draft");
    expect(textarea.maxLength).toBe(2000);
    expect(textarea.disabled).toBe(false);
    expect(send.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Waiting for both AIs to join.");
    fireEvent.change(textarea, { target: { value: "Draft\ncontinued" } });
    expect(props.onDraftChange).toHaveBeenCalledWith("Draft\ncontinued");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();

    room.ready = true;
    view.rerender(<CallSessionView {...props} draft="  " />);
    expect(send.disabled).toBe(true);
    view.rerender(<CallSessionView {...props} sending />);
    expect(send.disabled).toBe(true);
    expect(textarea.disabled).toBe(true);
    view.rerender(<CallSessionView {...props} inputError="Could not deliver" />);
    expect(screen.getByRole("alert").textContent).toBe("Could not deliver");
    expect(textarea.value).toBe("Draft");
    fireEvent.click(send);
    expect(props.onSubmit).toHaveBeenCalledOnce();
    view.rerender(<CallSessionView {...props} sending />);
    view.rerender(<CallSessionView {...props} sending={false} />);
    fireEvent.click(send);
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
  });
});

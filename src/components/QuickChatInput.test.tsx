// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickChatInput, type QuickChatInputStrings, QuickVoiceIndicator } from "./QuickChatInput";

const strings: QuickChatInputStrings = {
  placeholder: "Message Yori…",
  inputLabel: "Quick chat",
  send: "Send message",
  close: "Escape to close",
};

afterEach(cleanup);

describe("QuickChatInput", () => {
  it("retains a failed call draft and prevents duplicate sends while delivery is pending", () => {
    const onSubmit = vi.fn();
    const options = {
      value: "より、二人で考えて",
      strings,
      onChange: vi.fn(),
      onSubmit,
      onClose: vi.fn(),
    };
    const view = render(<QuickChatInput {...options} busy maxLength={2000} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: strings.send })).toHaveProperty("disabled", true);
    view.rerender(
      <QuickChatInput {...options} error="二人の接続を待っています" maxLength={2000} />,
    );
    expect(screen.getByRole("textbox")).toHaveProperty("value", options.value);
    expect(screen.getByRole("textbox")).toHaveProperty("maxLength", 2000);
    expect(screen.getByRole("alert").textContent).toContain("接続を待っています");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("focuses the input when it appears", () => {
    render(
      <QuickChatInput
        value=""
        strings={strings}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: strings.inputLabel }));
  });

  it("submits a non-empty message with Enter", () => {
    const onSubmit = vi.fn();
    render(
      <QuickChatInput
        value="hello"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not submit blank input or an IME composition", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <QuickChatInput
        value=" "
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    rerender(
      <QuickChatInput
        value="変換中"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <QuickChatInput
        value="draft"
        strings={strings}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses a multiline call editor and sends only with Ctrl+Enter, never plain Enter or Cmd+Enter", () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(
      <QuickChatInput
        submitOnControlEnter
        value={"first line\nsecond line"}
        strings={strings}
        onChange={onChange}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    const textarea = screen.getByRole("textbox");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toHaveProperty("value", "first line\nsecond line");
    expect(screen.getByText("Ctrl+Enter")).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "edited\nmessage" } });
    expect(onChange).toHaveBeenCalledWith("edited\nmessage");
    expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "Enter", metaKey: true })).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, keyCode: 229 });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.compositionEnd(textarea);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, repeat: true });
    fireEvent.click(screen.getByRole("button", { name: strings.send }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("supports the explicit call Send button and retry without clearing the draft", () => {
    const options = {
      submitOnControlEnter: true,
      value: "Draft\ncontinued",
      strings,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<QuickChatInput {...options} />);
    const send = screen.getByRole("button", { name: strings.send });
    fireEvent.click(send);
    view.rerender(<QuickChatInput {...options} busy />);
    fireEvent.submit(screen.getByRole("dialog"));
    expect(options.onSubmit).toHaveBeenCalledOnce();
    view.rerender(<QuickChatInput {...options} error="Retry the message" />);
    expect(screen.getByRole("textbox")).toHaveProperty("value", options.value);
    fireEvent.click(send);
    expect(options.onSubmit).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(options.onClose).toHaveBeenCalledOnce();
  });
});

describe("QuickVoiceIndicator", () => {
  it("shows the momentary voice state without a backdrop", () => {
    render(
      <QuickVoiceIndicator
        status="active"
        muted={false}
        connectingLabel="Connecting…"
        activeLabel="Listening…"
        mutedLabel="Muted"
        errorLabel="Voice unavailable"
        muteLabel="Mute microphone"
        unmuteLabel="Unmute microphone"
        shortcutMuteLabel="Command to mute"
        shortcutUnmuteLabel="Command to unmute"
        stopLabel="End voice conversation"
        onToggleMuted={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Listening…");
    expect(document.querySelector(".restore-confirm-backdrop")).toBeNull();
  });

  it("offers explicit mute and stop controls", () => {
    const onToggleMuted = vi.fn();
    const onStop = vi.fn();
    render(
      <QuickVoiceIndicator
        status="active"
        muted
        connectingLabel="Connecting…"
        activeLabel="Listening…"
        mutedLabel="Muted"
        errorLabel="Voice unavailable"
        muteLabel="Mute microphone"
        unmuteLabel="Unmute microphone"
        shortcutMuteLabel="Command to mute"
        shortcutUnmuteLabel="Command to unmute"
        stopLabel="End voice conversation"
        onToggleMuted={onToggleMuted}
        onStop={onStop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "End voice conversation" }));
    expect(onToggleMuted).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("Command to unmute");
  });
});

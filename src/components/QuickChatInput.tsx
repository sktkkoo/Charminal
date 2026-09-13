import { ArrowUp, Mic, MicOff, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface QuickChatInputStrings {
  readonly placeholder: string;
  readonly inputLabel: string;
  readonly send: string;
  readonly close: string;
}

export interface QuickChatInputProps {
  readonly portalTarget?: HTMLElement | null;
  readonly submitOnControlEnter?: boolean;
  readonly busy?: boolean;
  readonly error?: string;
  readonly maxLength?: number;
  readonly value: string;
  readonly strings: QuickChatInputStrings;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

export interface QuickVoiceIndicatorProps {
  readonly status: "connecting" | "active" | "error";
  readonly muted: boolean;
  readonly connectingLabel: string;
  readonly activeLabel: string;
  readonly mutedLabel: string;
  readonly errorLabel: string;
  readonly muteLabel: string;
  readonly unmuteLabel: string;
  readonly shortcutMuteLabel: string;
  readonly shortcutUnmuteLabel: string;
  readonly stopLabel: string;
  readonly onToggleMuted: () => void;
  readonly onStop: () => void;
}

export function QuickChatInput({
  portalTarget,
  submitOnControlEnter = false,
  busy = false,
  error,
  maxLength,
  value,
  strings,
  onChange,
  onSubmit,
  onClose,
}: QuickChatInputProps): React.ReactPortal | null {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const submittedValue = useRef<string | null>(null);

  useEffect(() => {
    if (!portalTarget || portalTarget.isConnected) inputRef.current?.focus();
  }, [portalTarget]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!submitOnControlEnter || !input || input.value !== value) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
  }, [value, submitOnControlEnter]);
  useEffect(() => {
    if (!submitOnControlEnter || !busy || submittedValue.current !== value) {
      submittedValue.current = null;
    }
  }, [busy, value, submitOnControlEnter]);

  if (typeof document === "undefined") return null;
  const canSubmit = !busy && value.trim().length > 0;
  const submit = () => {
    if (!canSubmit || composing.current) return;
    if (submitOnControlEnter) {
      if (submittedValue.current === value) return;
      submittedValue.current = value;
    }
    onSubmit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (
      event.key !== "Enter" ||
      composing.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    if (submitOnControlEnter && (!event.ctrlKey || event.metaKey || event.shiftKey || event.altKey))
      return;
    event.preventDefault();
    if (!submitOnControlEnter || !event.repeat) submit();
  };
  const editorProps = {
    "aria-label": strings.inputLabel,
    "aria-invalid": !!error,
    maxLength,
    autoComplete: "off",
    className: "quick-chat-input",
    onKeyDown,
    placeholder: strings.placeholder,
    ref: (element: HTMLInputElement | HTMLTextAreaElement | null) => {
      inputRef.current = element;
    },
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
    spellCheck: true,
    value,
  };

  return createPortal(
    <div className={`quick-chat-layer${portalTarget ? " is-docked" : ""}`} data-no-window-drag>
      <form
        aria-label={strings.inputLabel}
        className={`quick-chat-palette${submitOnControlEnter ? " is-multiline" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        role="dialog"
        aria-busy={busy}
      >
        {submitOnControlEnter ? (
          <textarea
            {...editorProps}
            rows={2}
            enterKeyHint="enter"
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        ) : (
          <input
            {...editorProps}
            enterKeyHint="send"
            onChange={(event) => onChange(event.currentTarget.value)}
            type="text"
          />
        )}
        <button
          aria-label={strings.send}
          className="quick-chat-send"
          disabled={!canSubmit}
          title={strings.send}
          type="submit"
        >
          <ArrowUp aria-hidden="true" size={17} strokeWidth={2.25} />
        </button>
        <span
          className="quick-chat-shortcut"
          aria-hidden="true"
          title={submitOnControlEnter ? strings.send : strings.close}
        >
          {submitOnControlEnter ? "Ctrl+Enter" : "esc"}
        </span>
      </form>
      {error && (
        <p className="quick-chat-call-error" role="alert">
          {error}
        </p>
      )}
    </div>,
    portalTarget ?? document.body,
  );
}

export function QuickVoiceIndicator({
  status,
  muted,
  connectingLabel,
  activeLabel,
  mutedLabel,
  errorLabel,
  muteLabel,
  unmuteLabel,
  shortcutMuteLabel,
  shortcutUnmuteLabel,
  stopLabel,
  onToggleMuted,
  onStop,
}: QuickVoiceIndicatorProps): React.ReactPortal | null {
  if (typeof document === "undefined") return null;
  const statusLabel =
    status === "active"
      ? muted
        ? mutedLabel
        : activeLabel
      : status === "error"
        ? errorLabel
        : connectingLabel;

  return createPortal(
    <div className="quick-chat-layer" data-no-window-drag>
      <div className="quick-voice-palette" role="status">
        <button
          aria-label={muted ? unmuteLabel : muteLabel}
          aria-pressed={!muted}
          className="quick-voice-icon"
          data-active={status === "active" && !muted}
          disabled={status !== "active"}
          onClick={onToggleMuted}
          title={muted ? unmuteLabel : muteLabel}
          type="button"
        >
          {muted ? (
            <MicOff aria-hidden="true" size={17} strokeWidth={2.15} />
          ) : (
            <Mic aria-hidden="true" size={17} strokeWidth={2.15} />
          )}
        </button>
        <span className="quick-voice-status">{statusLabel}</span>
        {status === "active" ? (
          <span className="quick-voice-shortcut">
            {muted ? shortcutUnmuteLabel : shortcutMuteLabel}
          </span>
        ) : null}
        <button
          aria-label={stopLabel}
          className="quick-voice-stop"
          onClick={onStop}
          title={stopLabel}
          type="button"
        >
          <X aria-hidden="true" size={15} strokeWidth={2.2} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

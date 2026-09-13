import { ArrowUp, Phone } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { CallEndIcon } from "./call-end-icon";
import type { RoomCall } from "./room-call";
import "./peer-call-control.css";

/** A temporary call surface. It never mounts a terminal or reads a work session. */
export function CallSessionView({
  room,
  language,
  draft,
  onDraftChange,
  onSubmit,
  sending,
  inputError,
  composerRef,
  onEnd,
}: {
  room: RoomCall | null;
  language: string;
  draft: string;
  onDraftChange(text: string): void;
  onSubmit(): void;
  sending: boolean;
  inputError?: string;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  onEnd(): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);
  const fallbackComposerRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = composerRef ?? fallbackComposerRef;
  const composing = useRef(false);
  const submittedDraft = useRef<string | null>(null);
  const lastTranscript = room?.transcripts[room.transcripts.length - 1];
  useEffect(() => {
    // A hidden xterm may still have had focus when the call tab was opened.
    surfaceRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const messages = messagesRef.current;
    if (lastTranscript && messages && followsLatest.current) {
      messages.scrollTop = messages.scrollHeight;
    }
  }, [lastTranscript]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.value !== draft) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 108)}px`;
  }, [draft, textareaRef]);
  useEffect(() => {
    if (!sending || submittedDraft.current !== draft) submittedDraft.current = null;
  }, [draft, sending]);
  const ja = language.startsWith("ja");
  const t = (jp: string, en: string) => (ja ? jp : en);
  const canSend = !!room?.ready && !sending && draft.trim().length > 0 && draft.length <= 2000;
  const submit = () => {
    if (!canSend || composing.current || submittedDraft.current === draft) return;
    submittedDraft.current = draft;
    onSubmit();
  };
  const status = sending
    ? t("送信中…", "Sending…")
    : room?.paused
      ? t("AIの会話を再開すると送信できます。", "Resume the AI conversation to send a message.")
      : !room?.connected
        ? t("接続後に送信できます。", "You can send once the call connects.")
        : !room.ready
          ? t("ふたりのAIが会話に参加するのを待っています。", "Waiting for both AIs to join.")
          : null;
  const error = inputError || room?.error;
  return (
    <section
      ref={surfaceRef}
      tabIndex={-1}
      className="call-session-workspace"
      aria-label={t("通話セッション", "Call session")}
    >
      <header>
        <Phone size={21} aria-hidden="true" />
        <div>
          <h2>{t("通話セッション", "Call session")}</h2>
          <p>
            {t(
              "この通話専用の会話です。終了すると元の作業へ戻ります。",
              "A separate conversation for this call. Return to your work when it ends.",
            )}
          </p>
        </div>
        <button type="button" className="peer-call-hangup" onClick={onEnd}>
          <CallEndIcon />
          {t("通話を終了", "End call")}
        </button>
      </header>
      <div
        ref={messagesRef}
        className="call-session-messages"
        onScroll={(event) => {
          const messages = event.currentTarget;
          followsLatest.current =
            messages.scrollHeight - messages.clientHeight - messages.scrollTop < 32;
        }}
        role="log"
        aria-live="off"
        aria-label={t("通話の会話", "Call conversation")}
      >
        {room?.transcripts.map((item) => (
          <div
            key={item.id}
            className="call-session-message"
            data-origin={item.origin}
            data-speaker-role={item.role}
          >
            <div className="call-session-message-speaker">
              <strong>
                {item.role === "user"
                  ? item.origin === "local"
                    ? t("あなた", "You")
                    : t("相手のユーザー", "Remote user")
                  : item.speaker}
              </strong>
              <span>{item.role === "user" ? t("人間", "Human") : "AI"}</span>
            </div>
            <p className="call-session-message-bubble">{item.text}</p>
          </div>
        ))}
        {!room?.transcripts.length && (
          <p className="call-session-empty">
            {room?.connected
              ? t(
                  "話題や進め方を渡して、ふたりの会話を始めましょう。",
                  "Share a topic or direction to start their conversation.",
                )
              : t("通話の接続を待っています。", "Waiting for the call to connect.")}
          </p>
        )}
      </div>
      <footer className="call-session-composer">
        {error && <p role="alert">{error}</p>}
        {status && (
          <p className="call-session-composer-status" role="status">
            {status}
          </p>
        )}
        <form
          aria-label={t("通話へのメッセージ", "Call message")}
          aria-busy={sending}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={textareaRef}
            aria-label={t("話題や進め方を渡す", "Share a topic or direction")}
            aria-invalid={!!error}
            autoComplete="off"
            disabled={sending}
            maxLength={2000}
            rows={1}
            value={draft}
            placeholder={t(
              "話題や進め方を入力（例：順番に意見を聞かせて）",
              "Share a topic or direction (e.g. take turns sharing your ideas)",
            )}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                !event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey ||
                composing.current ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              event.preventDefault();
              if (!event.repeat) submit();
            }}
          />
          <button
            className="call-session-send"
            type="submit"
            disabled={!canSend}
            aria-label={t("送信", "Send")}
            title={t("送信（Ctrl+Enter）", "Send (Ctrl+Enter)")}
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </form>
        <p className="call-session-composer-hint">
          {t("Enterで改行 · Ctrl+Enterで送信", "Enter for a new line · Ctrl+Enter to send")}
        </p>
      </footer>
    </section>
  );
}

import { MessageSquare, Phone, PhoneOff } from "lucide-react";
import { useEffect, useRef } from "react";
import type { RoomCall } from "./room-call";
import "./peer-call-control.css";

/** A temporary call surface. It never mounts a terminal or reads a work session. */
export function CallSessionView({
  room,
  language,
  onChat,
  onEnd,
}: {
  room: RoomCall | null;
  language: string;
  onChat(): void;
  onEnd(): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);
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
  const ja = language.startsWith("ja");
  const t = (jp: string, en: string) => (ja ? jp : en);
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
        <button type="button" onClick={onEnd}>
          <PhoneOff size={16} aria-hidden="true" />
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
                  "ふたりに話しかけて、会話を始めましょう。",
                  "Talk to both residents to start the conversation.",
                )
              : t("通話の接続を待っています。", "Waiting for the call to connect.")}
          </p>
        )}
      </div>
      <footer>
        {room?.error && <p role="alert">{room.error}</p>}
        <button type="button" onClick={onChat} disabled={!room?.connected}>
          <MessageSquare size={16} aria-hidden="true" />
          {t("ふたりに話しかける", "Talk to both residents")}
        </button>
      </footer>
    </section>
  );
}

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
  useEffect(() => {
    // A hidden xterm may still have had focus when the call tab was opened.
    surfaceRef.current?.focus({ preventScroll: true });
  }, []);
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
        className="call-session-messages"
        role="log"
        aria-live="off"
        aria-label={t("通話の会話", "Call conversation")}
      >
        {room?.transcripts.map((item) => (
          <p key={item.id}>
            <strong>{item.speaker}</strong>
            <span>{item.text}</span>
          </p>
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

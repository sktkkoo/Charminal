import { MessageSquare, Pause, Play, RotateCw, UserRound } from "lucide-react";
import { CallEndIcon } from "./call-end-icon";

/** Keep the call actions together even in a narrow resident sidebar. */
export function CallSessionToolbar({
  language,
  paused,
  retry,
  busy,
  onTopic,
  onShowResident,
  onPause,
  onResume,
  onEnd,
}: {
  language: string;
  paused: boolean;
  retry: boolean;
  busy: boolean;
  onTopic?: () => void;
  onShowResident?: () => void;
  onPause(): void;
  onResume(): void;
  onEnd(): void;
}) {
  const t = (jp: string, en: string) => (language.startsWith("ja") ? jp : en);
  const resumeLabel = retry
    ? t("AIの接続をやり直す", "Retry AI connection")
    : t("AIの会話を再開", "Resume AI conversation");
  return (
    <fieldset className="peer-call-session-toolbar" aria-label={t("通話の操作", "Call controls")}>
      {onShowResident && (
        <button
          type="button"
          onClick={onShowResident}
          title={t("相手のウィンドウを表示", "Show resident window")}
          aria-label={t("相手のウィンドウを表示", "Show resident window")}
        >
          <UserRound size={16} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        onClick={onTopic}
        aria-label={t("話題や進め方を渡す", "Share a topic or direction")}
        title={t("話題や進め方を渡す", "Share a topic or direction")}
      >
        <MessageSquare size={16} aria-hidden="true" />
      </button>
      {paused ? (
        <button
          type="button"
          disabled={busy}
          onClick={onResume}
          aria-label={resumeLabel}
          title={resumeLabel}
        >
          {retry ? (
            <RotateCw size={16} aria-hidden="true" />
          ) : (
            <Play size={16} aria-hidden="true" />
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={onPause}
          aria-label={t("AIの会話を止める", "Stop AI conversation")}
          title={t("AIの会話を止める", "Stop AI conversation")}
        >
          <Pause size={16} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="peer-call-hangup"
        onClick={onEnd}
        aria-label={t("通話を終了", "End call")}
        title={t("通話を終了", "End call")}
      >
        <CallEndIcon />
      </button>
    </fieldset>
  );
}

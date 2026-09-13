import { LockKeyhole, MessageSquarePlus, Shield } from "lucide-react";

/** Describes the call configuration before startup; it is not a live verification result. */
export function CallAiDisclosure({ language = "ja" }: { language?: string }) {
  const t = (jp: string, en: string) => (language.startsWith("ja") ? jp : en);
  return (
    <section
      className="peer-call-ai-disclosure"
      aria-label={t("通話中の保護設定", "Call safeguards")}
    >
      <div className="peer-call-ai-heading">
        <Shield size={14} aria-hidden="true" />
        <strong>{t("通話中の保護設定", "Call safeguards")}</strong>
      </div>
      <p className="peer-call-ai-reason">
        {t(
          "このPCを保護するため、ツール・MCP・シェルを無効にします。通話からのファイル操作やコマンド実行を制限する設定です。",
          "Tools, MCP and shell are disabled to protect this PC. These settings restrict file access and command execution from the call.",
        )}
      </p>
      <div className="peer-call-ai-badges">
        <span>
          <MessageSquarePlus size={13} aria-hidden="true" />
          {t("新規セッション", "New session")}
        </span>
        <span className="is-protected">
          <LockKeyhole size={13} aria-hidden="true" />
          {t("ツール無効", "Tools off")}
        </span>
        <span className="is-protected">
          <LockKeyhole size={13} aria-hidden="true" />
          {t("MCP無効", "MCP off")}
        </span>
        <span className="is-protected">
          <LockKeyhole size={13} aria-hidden="true" />
          {t("シェル無効", "Shell off")}
        </span>
      </div>
      <p className="peer-call-ai-description">
        {t(
          "通話専用の新しいAIセッションで接続します。作業用のセッションや会話履歴は引き継ぎません。",
          "Connects with a new AI session for this call. Your work session and conversation history are not carried over.",
        )}
      </p>
    </section>
  );
}

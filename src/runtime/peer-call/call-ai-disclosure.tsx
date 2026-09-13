import { MessageSquarePlus, Terminal, Unplug, Wrench } from "lucide-react";

/** Describes the call configuration before startup; it is not a live verification result. */
export function CallAiDisclosure({ language = "ja" }: { language?: string }) {
  const t = (jp: string, en: string) => (language.startsWith("ja") ? jp : en);
  return (
    <section className="peer-call-ai-disclosure" aria-label={t("通話AIの設定", "Call AI setup")}>
      <div className="peer-call-ai-badges">
        <span>
          <MessageSquarePlus size={13} aria-hidden="true" />
          {t("新規セッション", "New session")}
        </span>
        <span>
          <Wrench size={13} aria-hidden="true" />
          {t("ツール無効", "Tools off")}
        </span>
        <span>
          <Unplug size={13} aria-hidden="true" />
          {t("MCP無効", "MCP off")}
        </span>
        <span>
          <Terminal size={13} aria-hidden="true" />
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

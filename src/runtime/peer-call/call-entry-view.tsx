import {
  ArrowRight,
  Check,
  ChevronLeft,
  Copy,
  MicOff,
  Phone,
  PhoneIncoming,
  Plus,
  Settings2,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CallAiDisclosure } from "./call-ai-disclosure";
import type { CallControlsAction, CallEntrySnapshot } from "./call-controls-window";
import { CallEndIcon } from "./call-end-icon";
import { callIdentityDiagnostic } from "./call-identity";
import "./peer-call-control.css";

function isLegacyCallEndpoint(endpoint: string) {
  try {
    return new URL(endpoint).pathname === "/rooms";
  } catch {
    return false;
  }
}

const PRESENCE_ERRORS: Record<string, string> = {
  "通話の識別情報を準備できませんでした。アプリを再起動してお試しください。":
    "Could not prepare your call identity. Restart the app and try again.",
  "通話サーバーとの通信形式を確認できませんでした。":
    "Could not verify communication with the call server.",
  "通話へのリクエストが多すぎます。しばらくしてからお試しください。":
    "Too many call requests. Wait a while and try again.",
  "通話の待受に接続できませんでした。": "Could not connect to receive calls.",
  "通話の待受に接続できませんでした。アプリを再起動してお試しください。":
    "Could not connect to receive calls. Restart the app and try again.",
};

function presenceErrorMessage(error: string | undefined, language: "ja" | "en") {
  if (!error) return "";
  const diagnostic = callIdentityDiagnostic(error) ?? "";
  const message = diagnostic ? error.slice(0, -diagnostic.length) : error;
  if (!Object.getOwnPropertyDescriptor(PRESENCE_ERRORS, message)) return "";
  return (language === "ja" ? message : PRESENCE_ERRORS[message]) + diagnostic;
}

/** Presentation only. All room, media and admission operations belong to the main window. */
export function CallEntryView({
  state,
  onAction,
  onHide,
  detached = false,
  localAvatarPreview,
}: {
  state: CallEntrySnapshot;
  onAction: (action: CallControlsAction) => void | Promise<void>;
  onHide: () => void;
  detached?: boolean;
  localAvatarPreview?: ReactNode;
}) {
  const { language, active, busy, endpoint, localName, remoteName, status, guest } = state;
  const t = (jp: string, en: string) => (language === "ja" ? jp : en);
  const [callName, setCallName] = useState(state.name);
  const nameEdited = useRef(false);
  const [invitation, setInvitation] = useState("");
  const [settings, setSettings] = useState(false);
  const [endpointDraft, setEndpointDraft] = useState(endpoint);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [localNotice, setNotice] = useState("");
  const notice = localNotice || state.notice;
  const [requesting, setRequesting] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const inviteInput = useRef<HTMLInputElement>(null);
  const callError = error || state.error;
  const contactFailure =
    !active &&
    !state.incoming &&
    !settings &&
    !error &&
    callError &&
    state.contacts?.some((contact) => contact.identityId === state.failedContactId);
  const incoming = state.incoming;
  const signal = { state: state.signalState, invitation: state.invitation, role: state.role };
  const presenceStatus =
    state.presenceState === "connecting"
      ? t("通話サービスに接続中…", "Connecting to the call service…")
      : state.presenceState === "offline"
        ? t(
            "通話の待受に接続できません。接続をやり直しています。",
            "Cannot connect to receive calls. Reconnecting…",
          )
        : state.presenceState === "error"
          ? presenceErrorMessage(state.presenceError, language) ||
            t(
              "通話の待受に接続できませんでした。アプリを再起動してお試しください。",
              "Could not connect to receive calls. Restart the app and try again.",
            )
          : t("通話サービスに接続していません。", "Not connected to the call service.");
  useEffect(() => {
    if (!nameEdited.current) setCallName(state.name);
  }, [state.name]);
  useEffect(() => {
    setEndpointDraft(endpoint);
    setSettings(false);
  }, [endpoint]);
  useEffect(() => {
    if (state.notice === "接続先を保存しました。" || state.notice === "Connection saved.")
      setSettings(false);
  }, [state.notice]);
  useEffect(() => {
    if (active) setSettings(false);
    if (state.invitation) setCopied(false);
  }, [active, state.invitation]);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  async function request(action: CallControlsAction) {
    if (requesting && action.type !== "cancel") return;
    setRequesting(true);
    setError("");
    try {
      const result = onAction(action);
      if (result) await result;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setRequesting(false);
    }
  }
  const disclosure = t(
    "参加すると、名前・アバター・通話の音声を相手と共有し、AIとの会話にはOpenAIとCodexの利用枠を使います。マイクはオフで始まります。オンにしたマイクは通話相手と両方のAIに届きます。ターミナルの内容は自動共有しません。",
    "Joining shares your name, avatar and call audio with the other participant. AI conversation uses OpenAI and your Codex allowance. Your microphone starts off. Your enabled microphone reaches the participant and both AIs. Terminal content is not automatically shared.",
  );
  const incomingActions = (
    <div className="peer-call-actions">
      <button
        type="button"
        className="peer-call-secondary"
        disabled={requesting || !!busy || requesting}
        onClick={() => guest && void request({ type: "decline", requestId: guest.requestId })}
      >
        {t("拒否", "Decline")}
      </button>
      <button
        type="button"
        className="peer-call-primary"
        disabled={requesting || !!busy || requesting}
        onClick={() => guest && void request({ type: "accept", requestId: guest.requestId })}
      >
        <Phone size={16} aria-hidden="true" />
        {t("通話に出る", "Answer")}
      </button>
    </div>
  );
  return (
    <div className={detached ? "peer-call-detached" : "peer-call-backdrop"}>
      <section
        ref={panel}
        tabIndex={-1}
        className={`peer-call-room layout-call${detached ? " is-detached" : ""}`}
        role="dialog"
        aria-label={t("通話", "Call")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onHide();
          }
        }}
      >
        <header className="peer-call-heading">
          <span className="peer-call-heading-icon">
            <Phone size={18} aria-hidden="true" />
          </span>
          <div className="peer-call-heading-copy">
            <h2>{t("通話", "Call")}</h2>
            <p role="status">
              <i className={active ? "is-live" : ""} />
              {status}
            </p>
          </div>
          <div className="peer-call-actions">
            {!active && (
              <button
                type="button"
                className="peer-call-icon-button"
                aria-label={t("通話の設定", "Call settings")}
                aria-pressed={settings}
                onClick={() => {
                  setSettings((v) => !v);
                  setEndpointDraft(endpoint);
                }}
              >
                <Settings2 size={17} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="peer-call-icon-button"
              aria-label={t("通話画面を閉じる", "Hide call")}
              onClick={onHide}
            >
              <X size={19} aria-hidden="true" />
            </button>
          </div>
        </header>
        {callError && !contactFailure && (
          <p className="peer-call-error" role="alert">
            {callError}
          </p>
        )}
        {incoming && !active ? (
          <div className="peer-call-direct-incoming">
            <PhoneIncoming size={32} aria-hidden="true" />
            <h3>{t(`${incoming.name}から着信です`, `${incoming.name} is calling`)}</h3>
            <CallAiDisclosure language={language} />
            <p className="peer-call-disclosure">{disclosure}</p>
            <div className="peer-call-actions">
              <button
                type="button"
                className="peer-call-secondary"
                disabled={requesting || !!busy}
                onClick={() => void request({ type: "decline-contact", roomId: incoming.roomId })}
              >
                {t("拒否", "Decline")}
              </button>
              <button
                type="button"
                className="peer-call-primary"
                disabled={requesting || !!busy}
                onClick={() => void request({ type: "answer-contact", roomId: incoming.roomId })}
              >
                <Phone size={16} aria-hidden="true" />
                {t("通話に出る", "Answer")}
              </button>
            </div>
          </div>
        ) : !active ? (
          <div className="peer-call-entry-scroll">
            {settings ? (
              <form
                className="peer-call-settings"
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    void request({ type: "save-endpoint", endpoint: endpointDraft.trim() });
                  } catch (value) {
                    setError(value instanceof Error ? value.message : String(value));
                  }
                }}
              >
                <button type="button" className="peer-call-back" onClick={() => setSettings(false)}>
                  <ChevronLeft size={16} aria-hidden="true" />
                  {t("戻る", "Back")}
                </button>
                <h3>{t("通話の接続先", "Call connection")}</h3>
                <p>
                  {t(
                    "両方のPCで同じ通話サーバーを使います。設定はこのPCに保存されます。",
                    "Both PCs need the same call server. This setting is saved on this PC.",
                  )}
                </p>
                <label htmlFor="peer-call-endpoint">{t("通話サーバー", "Call server")}</label>
                <input
                  id="peer-call-endpoint"
                  value={endpointDraft}
                  onChange={(event) => setEndpointDraft(event.target.value)}
                  placeholder="wss://example.com/v2/rooms"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={2048}
                />
                <button
                  type="submit"
                  className="peer-call-primary"
                  disabled={!endpointDraft.trim()}
                >
                  {t("保存する", "Save")}
                </button>
              </form>
            ) : (
              <div className="peer-call-welcome">
                <div className="peer-call-entry-art" aria-hidden="true">
                  <span>{localName.slice(0, 1)}</span>
                  <div>
                    <i />
                    <i />
                    <i />
                  </div>
                  <span>
                    <UserRound size={29} />
                  </span>
                </div>
                <h3>{t("通話を始める", "Start a call")}</h3>
                <p className="peer-call-intro">
                  {t(
                    "別のPCのYorishiroと接続します。二人のAIにお題を渡して会話を聞いたり、マイクで参加したりできます。",
                    "Connect to a resident on another PC. Give the two AIs a topic, listen to their conversation, or join using your microphone.",
                  )}
                </p>
                <CallAiDisclosure language={language} />
                <div className="peer-call-entry-identity">
                  <span className="peer-call-avatar-initial">{localName.slice(0, 1)}</span>
                  <label className="peer-call-name-field" htmlFor="peer-call-name">
                    <span>{t("通話での名前", "Name in this call")}</span>
                    <input
                      id="peer-call-name"
                      value={callName}
                      maxLength={64}
                      autoComplete="off"
                      onChange={(event) => {
                        nameEdited.current = true;
                        setCallName(event.target.value);
                      }}
                    />
                  </label>
                  <MicOff size={16} aria-label={t("マイクはオフ", "Microphone off")} />
                </div>
                {state.presenceState && (
                  <section
                    className="peer-call-contacts"
                    aria-label={t("通話した相手", "Contacts")}
                  >
                    <h4>{t("通話した相手", "Contacts")}</h4>
                    {state.presenceState !== "online" && (
                      <p
                        className={
                          state.presenceState === "error" ? "peer-call-contact-error" : undefined
                        }
                        role={state.presenceState === "error" ? "alert" : "status"}
                      >
                        {presenceStatus}
                      </p>
                    )}
                    {!state.contacts?.length && state.presenceState === "online" && (
                      <p>
                        {t(
                          "初めての相手は招待コードでつながります。通話した相手はここから呼び出せます。",
                          "Use an invitation code for your first call. Afterwards, call the same person from here.",
                        )}
                      </p>
                    )}
                    <ul>
                      {state.contacts?.map((contact) => (
                        <li key={contact.identityId}>
                          <div className="peer-call-contact-copy">
                            <span className="peer-call-contact-name" title={contact.name}>
                              {contact.name}
                            </span>
                            {contactFailure && state.failedContactId === contact.identityId && (
                              <small className="peer-call-contact-error" role="alert">
                                {callError}
                              </small>
                            )}
                          </div>
                          <button
                            type="button"
                            className="peer-call-secondary"
                            aria-label={t(`${contact.name}に通話`, `Call ${contact.name}`)}
                            disabled={
                              requesting ||
                              !!busy ||
                              !callName.trim() ||
                              state.presenceState !== "online"
                            }
                            onClick={() =>
                              void request({
                                type: "call-contact",
                                name: callName.trim(),
                                identityId: contact.identityId,
                              })
                            }
                          >
                            <Phone size={15} aria-hidden="true" />
                            {t("通話", "Call")}
                          </button>
                          <button
                            type="button"
                            className="peer-call-secondary peer-call-remove-contact"
                            aria-label={t(
                              `${contact.name}を連絡先から削除`,
                              `Remove ${contact.name} from contacts`,
                            )}
                            title={t(
                              "削除すると、再び招待するまでこの相手からの着信を受けません。",
                              "Removing this contact prevents direct calls until you accept a new invitation.",
                            )}
                            disabled={requesting || !!busy || state.presenceState !== "online"}
                            onClick={() =>
                              void request({
                                type: "remove-contact",
                                identityId: contact.identityId,
                              })
                            }
                          >
                            <Trash2 size={15} aria-hidden="true" />
                            {t("削除", "Remove")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {isLegacyCallEndpoint(endpoint) && (
                  <div className="peer-call-setup-notice" role="note">
                    <span>
                      {t(
                        "現在の接続先は招待コード専用です。通話した相手は再発信用に保存されず、毎回招待コードが必要です。",
                        "This connection uses invitation codes only. People you call are not saved for redial, so each call needs a new invitation code.",
                      )}
                    </span>
                    <button type="button" onClick={() => setSettings(true)}>
                      {t("接続先を確認", "Check connection")}
                    </button>
                  </div>
                )}
                {!endpoint && (
                  <div className="peer-call-setup-notice">
                    <span>
                      {t(
                        "最初に通話の接続先を設定してください。",
                        "Set up your call connection to get started.",
                      )}
                    </span>
                    <button type="button" onClick={() => setSettings(true)}>
                      {t("設定する", "Set up")}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="peer-call-primary peer-call-create"
                  disabled={requesting || !!busy || !endpoint || !callName.trim()}
                  onClick={() => void request({ type: "create", name: callName.trim() })}
                >
                  <Plus size={17} aria-hidden="true" />
                  {busy === "create"
                    ? t("招待を準備しています…", "Preparing an invitation…")
                    : t("新しい相手を招待", "Invite someone new")}
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
                <div className="peer-call-or">
                  <span>{t("招待コードで参加", "Join with an invitation code")}</span>
                </div>
                <form
                  className="peer-call-join"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (invitation.trim() && endpoint && callName.trim() && !busy)
                      void request({
                        type: "join",
                        name: callName.trim(),
                        invitation: invitation.trim(),
                      });
                  }}
                >
                  <label className="peer-call-sr-only" htmlFor="peer-call-invitation">
                    {t("招待コード", "Invitation code")}
                  </label>
                  <input
                    id="peer-call-invitation"
                    value={invitation}
                    onChange={(event) => setInvitation(event.target.value)}
                    placeholder={t("招待コードを貼り付ける", "Paste an invitation code")}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={80}
                  />
                  <button
                    type="submit"
                    disabled={
                      requesting || !!busy || !endpoint || !callName.trim() || !invitation.trim()
                    }
                  >
                    {t("参加する", "Join")}
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                </form>
                <p className="peer-call-disclosure">{disclosure}</p>
                {notice && (
                  <p className="peer-call-notice" role="status">
                    {notice}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="peer-call-body">
              <main className="peer-call-main">
                <div className="peer-call-stage-wrap">
                  <div className="peer-call-waiting-stage">
                    <div className="peer-call-resident-tile">
                      {localAvatarPreview ?? (
                        <div className="peer-call-placeholder">
                          <UserRound size={44} />
                          <strong>{localName}</strong>
                        </div>
                      )}
                    </div>
                    <div
                      className={`peer-call-resident-tile peer-call-remote-tile${guest ? " is-ringing" : ""}`}
                    >
                      <div className="peer-call-placeholder">
                        {guest ? <PhoneIncoming size={32} /> : <UserRound size={40} />}
                        <strong>
                          {guest?.name ||
                            state.directTarget ||
                            (signal?.role === "guest"
                              ? remoteName
                              : t("参加待ち", "Waiting for a participant"))}
                        </strong>
                        <small>
                          {guest
                            ? t("着信しています", "Incoming call")
                            : t("相手の参加を待っています", "Waiting for the other participant")}
                        </small>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="peer-call-waiting-copy">
                  {guest ? (
                    <>
                      <h3>{t(`${guest.name}から着信です`, `${guest.name} is calling`)}</h3>
                      <CallAiDisclosure language={language} />
                      {incomingActions}
                    </>
                  ) : state.directTarget ? (
                    <>
                      <h3>
                        {t(
                          `${state.directTarget}を呼び出しています…`,
                          `Calling ${state.directTarget}…`,
                        )}
                      </h3>
                      <p>
                        {t(
                          "相手が通話に出るのを待っています。",
                          "Waiting for the other person to answer.",
                        )}
                      </p>
                    </>
                  ) : signal?.state === "hosting" ? (
                    <>
                      <h3>{t("招待の準備ができました", "Your invitation is ready")}</h3>
                      <p>
                        {t(
                          "招待コードを相手に送ってください。",
                          "Send the invitation code to the other participant.",
                        )}
                      </p>
                      <div className="peer-call-invite-copy">
                        <input
                          ref={inviteInput}
                          readOnly
                          value={signal.invitation}
                          aria-label={t("部屋の招待コード", "Your room invitation")}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            void (async () => {
                              try {
                                await navigator.clipboard.writeText(signal.invitation);
                                setCopied(true);
                              } catch {
                                inviteInput.current?.focus();
                                inviteInput.current?.select();
                                setNotice(
                                  t(
                                    "招待コードを選択しました。コピーして相手に渡してください。",
                                    "Invitation selected. Copy it and send it to your guest.",
                                  ),
                                );
                              }
                            })()
                          }
                        >
                          {copied ? (
                            <Check size={16} aria-hidden="true" />
                          ) : (
                            <Copy size={16} aria-hidden="true" />
                          )}
                          {copied
                            ? t("コピーしました", "Copied")
                            : t("招待をコピー", "Copy invitation")}
                        </button>
                      </div>
                      <small>
                        {t(
                          "招待は5分間有効です。通話に出るまで、音声は共有されません。",
                          "The invitation lasts five minutes. Audio is shared only after you answer.",
                        )}
                      </small>
                      {notice && <p role="status">{notice}</p>}
                    </>
                  ) : (
                    <>
                      <h3>
                        {signal?.state === "requesting"
                          ? t(`${remoteName}を呼び出しています…`, `Calling ${remoteName}…`)
                          : t("接続中", "Connecting")}
                      </h3>
                      <p>
                        {signal?.state === "requesting"
                          ? t(
                              "相手が通話に出るのを待っています。",
                              "Waiting for the host to answer.",
                            )
                          : t("このままお待ちください。", "Please stay here for a moment.")}
                      </p>
                    </>
                  )}
                </div>
              </main>
            </div>
            <footer className="peer-call-footer">
              <p>{status}</p>
              <button
                type="button"
                className="peer-call-hangup"
                onClick={() => void request({ type: "cancel" })}
              >
                <CallEndIcon />
                {t("キャンセル", "Cancel")}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

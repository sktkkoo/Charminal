import {
  ArrowRight,
  Check,
  ChevronLeft,
  Copy,
  MessageSquare,
  MicOff,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneOff,
  Plus,
  Settings2,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import { captureAvatarMotion } from "./avatar-motion";
import { type NativeCallAvatarProps, NativeCallStage } from "./call-avatar";
import { configuredRoomEndpoint, persistRoomEndpoint, RoomCall } from "./room-call";
import "./peer-call-control.css";

interface Props {
  avatarUrl?: string | null;
  residentName?: string;
  publicDescription?: string;
  language?: string;
  viewMode?: string | null;
  onActiveChange?: (active: boolean) => void;
  getVoice?: () => Promise<string | undefined>;
  onRoomChange?: (room: RoomCall | null) => void;
  onTopicRequested?: () => void;
  onShowResident?: () => void;
}

type Layout = "theater" | "call" | "portrait";
function layoutFor(viewMode?: string | null): Layout {
  if (viewMode === "theater") return "theater";
  // UI pack IDs differ from their display names: portrait is Call; companion is Portrait.
  return viewMode === "companion" ? "portrait" : "call";
}

function sampleLocalPose() {
  try {
    const vrm = getThreeRuntime().getVrm();
    return vrm ? captureAvatarMotion(vrm, 0, performance.now()).pose : null;
  } catch {
    return null;
  }
}

/** A quiet incoming-call cue. Visual admission remains available if autoplay is unavailable. */
function useIncomingRing(requestId: string | undefined) {
  useEffect(() => {
    if (!requestId || !window.AudioContext) return;
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    const ring = () => {
      if (context.state !== "running") return;
      for (const delay of [0, 0.28]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + delay;
        oscillator.frequency.value = delay ? 660 : 523.25;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.21);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
      }
    };
    void context
      .resume()
      .then(ring)
      .catch(() => {});
    const timer = window.setInterval(ring, 5_000);
    return () => {
      window.clearInterval(timer);
      void context.close().catch(() => {});
    };
  }, [requestId]);
}

/** The room outlives its surface. Only leaving or closing the app disposes the call. */
export function PeerCallControl({
  avatarUrl = null,
  residentName,
  publicDescription = "",
  language = "ja",
  viewMode,
  onActiveChange,
  getVoice,
  onRoomChange,
  onTopicRequested,
  onShowResident,
}: Props) {
  const ja = language.startsWith("ja");
  const t = (jp: string, en: string) => (ja ? jp : en);
  const name = residentName?.trim() || t("より", "Yori");
  const [callName, setCallName] = useState(name);
  const nameEdited = useRef(false);
  const [open, setOpen] = useState(false);
  const layout = layoutFor(viewMode);
  const [room, setRoom] = useState<RoomCall | null>(null);
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invitation, setInvitation] = useState("");
  const [settings, setSettings] = useState(false);
  const [endpoint, setEndpoint] = useState(configuredRoomEndpoint);
  const [endpointDraft, setEndpointDraft] = useState(endpoint);
  const [copied, setCopied] = useState(false);
  const owned = useRef<RoomCall | null>(null);
  const mounted = useRef(true);
  const action = useRef(0);
  const operationBusy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const inviteInput = useRef<HTMLInputElement>(null);
  const identity = useRef({ name, avatarUrl });
  const activeCallback = useRef(onActiveChange);
  activeCallback.current = onActiveChange;

  const roomCallback = useRef(onRoomChange);
  roomCallback.current = onRoomChange;
  const changed = useCallback(() => {
    if (!mounted.current) return;
    refresh((value) => value + 1);
    roomCallback.current?.(owned.current?.closed ? null : owned.current);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const dispose = () => {
      ++action.current;
      owned.current?.leave();
      owned.current = null;
      roomCallback.current?.(null);
    };
    window.addEventListener("pagehide", dispose);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", dispose);
      dispose();
    };
  }, []);
  useEffect(() => {
    if (!nameEdited.current) setCallName(name);
  }, [name]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  const active = !!room && !room.closed;
  const connected = active && room.connected;
  useEffect(() => {
    if (connected) setOpen(false);
  }, [connected]);
  const signal = room?.signaling;
  const guest = active ? signal?.pendingGuest : null;
  const requestId = signal?.state === "pending" ? guest?.requestId : undefined;
  useIncomingRing(requestId);
  const localName = active ? identity.current.name : callName.trim() || name;
  const localAvatar = active ? identity.current.avatarUrl : avatarUrl;
  const remoteName = signal?.remoteName || guest?.name || t("相手のよりしろ", "Other resident");
  const callError = error || room?.error || signal?.error;
  const status = !active
    ? t("招待するか招待コードで参加してください", "Invite someone or enter an invitation code")
    : guest
      ? t("着信中", "Incoming call")
      : connected
        ? room.error && room.paused
          ? t("AIに接続できませんでした", "AI connection failed")
          : room.paused
            ? t("AIの会話は停止中", "AI conversation stopped")
            : room.ready
              ? t("通話中", "In call")
              : t("AIに接続中", "Connecting to the AIs")
        : signal?.state === "hosting"
          ? t("開室中 · 相手を待っています", "Room open · Waiting for a guest")
          : signal?.state === "requesting"
            ? t("呼び出し中", "Calling")
            : t("接続中", "Connecting");

  function leave() {
    ++action.current;
    operationBusy.current = false;
    owned.current?.leave();
    owned.current = null;
    setRoom(null);
    roomCallback.current?.(null);
    setBusy(null);
    setError("");
    setNotice(t("通話を終了しました。", "The call has ended."));
  }

  async function run(label: string, task: () => Promise<unknown> | undefined) {
    if (operationBusy.current) return;
    operationBusy.current = true;
    const current = ++action.current;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (value) {
      if (mounted.current && current === action.current)
        setError(
          value instanceof Error
            ? value.message
            : t("操作できませんでした。", "That action failed."),
        );
    } finally {
      if (current === action.current) {
        operationBusy.current = false;
        if (mounted.current) setBusy(null);
      }
    }
  }

  function begin(kind: "create" | "join") {
    void run(kind, async () => {
      owned.current?.leave();
      identity.current = { name: callName.trim(), avatarUrl };
      const next = new RoomCall({
        endpoint,
        name: callName.trim(),
        publicDescription,
        avatarUrl,
        getVoice,
        onChange: changed,
        onActiveChange: (value) => activeCallback.current?.(value),
      });
      owned.current = next;
      setRoom(next);
      roomCallback.current?.(next);
      setCopied(false);
      setSettings(false);
      if (kind === "create") await next.create();
      else await next.join(invitation.trim());
    });
  }

  function answer() {
    setOpen(true);
    void run("accept", () => room?.accept());
  }

  const participants: NativeCallAvatarProps[] = localAvatar
    ? [
        {
          avatarUrl: localAvatar,
          label: localName,
          sampleMotion: sampleLocalPose,
        },
      ]
    : [];
  const disclosure = t(
    "参加すると、名前・アバター・通話の音声を相手と共有し、AIとの会話にはOpenAIとCodexの利用枠を使います。マイクはオフで始まります。オンにしたマイクは通話相手と両方のAIに届きます。ターミナルの内容は自動共有しません。",
    "Joining shares your name, avatar and call audio with the other participant. AI conversation uses OpenAI and your Codex allowance. Your microphone starts off. Your enabled microphone reaches the participant and both AIs. Terminal content is not automatically shared.",
  );
  const incomingActions = (
    <div className="peer-call-actions">
      <button
        type="button"
        className="peer-call-secondary"
        disabled={!!busy}
        onClick={() => void run("reject", () => room?.reject())}
      >
        {t("拒否", "Decline")}
      </button>
      <button type="button" className="peer-call-primary" disabled={!!busy} onClick={answer}>
        <Phone size={16} aria-hidden="true" />
        {t("通話に出る", "Answer")}
      </button>
    </div>
  );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`title-bar-button peer-call-trigger${active ? " is-active" : ""}`}
        title={connected ? t("通話を終了", "End call") : t("通話", "Call")}
        aria-label={connected ? t("通話を終了", "End call") : t("通話", "Call")}
        aria-haspopup={connected ? undefined : "dialog"}
        aria-expanded={connected ? undefined : open}
        onClick={() => (connected ? leave() : setOpen((value) => !value))}
      >
        {connected ? (
          <PhoneOff size={15} aria-hidden="true" />
        ) : (
          <Phone size={15} aria-hidden="true" />
        )}
        {active && <span className="peer-call-dot" />}
      </button>
      {connected &&
        createPortal(
          <aside
            className="peer-call-session-strip"
            aria-label={t("通話中", "In call")}
            data-no-window-drag
          >
            <span className="peer-call-session-status" role="status">
              <strong>
                {localName} · {remoteName}
              </strong>
              <small>{status}</small>
            </span>
            {onShowResident && layout !== "theater" && (
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
              onClick={onTopicRequested}
              aria-label={t("チャットを開く", "Open chat")}
              title={t("チャットを開く", "Open chat")}
            >
              <MessageSquare size={16} aria-hidden="true" />
            </button>
            {room.paused ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void run("retry", () => room.resume())}
              >
                {room.error
                  ? t("AIの接続をやり直す", "Retry AI connection")
                  : t("AIの会話を再開", "Resume AI conversation")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  ++action.current;
                  operationBusy.current = false;
                  setBusy(null);
                  room.pause();
                }}
                aria-label={t("AIの会話を止める", "Stop AI conversation")}
                title={t("AIの会話を止める", "Stop AI conversation")}
              >
                <Pause size={16} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="peer-call-hangup"
              onClick={leave}
              aria-label={t("通話を終了", "End call")}
              title={t("通話を終了", "End call")}
            >
              <PhoneOff size={16} aria-hidden="true" />
            </button>
            <div
              className="peer-call-sr-only"
              role="log"
              aria-label={t("通話の字幕", "Call captions")}
              aria-live="off"
            >
              {room.transcripts.slice(-8).map((item) => (
                <p key={item.id}>
                  {item.speaker}: {item.text}
                </p>
              ))}
            </div>
            {callError && (
              <details className="peer-call-session-error">
                <summary>{t("接続エラーの詳細", "Connection error details")}</summary>
                <p role="alert">{callError}</p>
              </details>
            )}
          </aside>,
          document.body,
        )}
      {active &&
        !connected &&
        !open &&
        createPortal(
          guest ? (
            <aside
              className="peer-call-incoming-toast"
              aria-label={t("着信", "Incoming call")}
              aria-live="polite"
            >
              <PhoneIncoming size={21} aria-hidden="true" />
              <div>
                <strong>{guest.name}</strong>
                <p>{t("部屋への参加を希望しています", "Would like to join your room")}</p>
              </div>
              {incomingActions}
            </aside>
          ) : (
            <button
              type="button"
              className="peer-call-dock"
              onClick={() => setOpen(true)}
              aria-label={t("通話に戻る", "Return to call")}
            >
              <Phone size={15} aria-hidden="true" />
              <span>
                <strong>{t("あなたの部屋", "Your room")}</strong>
                <small>{status}</small>
              </span>
            </button>
          ),
          document.body,
        )}
      {open &&
        !connected &&
        createPortal(
          <div className="peer-call-backdrop">
            <section
              ref={panel}
              tabIndex={-1}
              className={`peer-call-room layout-${layout}`}
              role="dialog"
              aria-modal="true"
              aria-label={t("通話", "Call")}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  trigger.current?.focus();
                }
                if (event.key === "Tab") {
                  const elements = Array.from(
                    panel.current?.querySelectorAll<HTMLElement>(
                      'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
                    ) ?? [],
                  ).sort((a, b) => {
                    if (a === b) return 0;
                    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                  });
                  const first = elements[0],
                    last = elements[elements.length - 1];
                  if (
                    event.shiftKey &&
                    (document.activeElement === first || document.activeElement === panel.current)
                  ) {
                    event.preventDefault();
                    last?.focus();
                  } else if (
                    !event.shiftKey &&
                    (document.activeElement === last || document.activeElement === panel.current)
                  ) {
                    event.preventDefault();
                    first?.focus();
                  }
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
                    onClick={() => setOpen(false)}
                  >
                    <X size={19} aria-hidden="true" />
                  </button>
                </div>
              </header>
              {callError && (
                <p className="peer-call-error" role="alert">
                  {callError}
                </p>
              )}
              {!active ? (
                <div className="peer-call-entry-scroll">
                  {settings ? (
                    <form
                      className="peer-call-settings"
                      onSubmit={(event) => {
                        event.preventDefault();
                        try {
                          persistRoomEndpoint(endpointDraft.trim());
                          setEndpoint(configuredRoomEndpoint());
                          setSettings(false);
                          setError("");
                        } catch (value) {
                          setError(value instanceof Error ? value.message : String(value));
                        }
                      }}
                    >
                      <button
                        type="button"
                        className="peer-call-back"
                        onClick={() => setSettings(false)}
                      >
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
                        placeholder="wss://example.com/rooms"
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
                          "別のPCのよりしろと接続します。二人のAIにお題を渡して会話を聞いたり、マイクで参加したりできます。",
                          "Connect to a resident on another PC. Give the two AIs a topic, listen to their conversation, or join using your microphone.",
                        )}
                      </p>
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
                        disabled={!!busy || !endpoint || !callName.trim()}
                        onClick={() => begin("create")}
                      >
                        <Plus size={17} aria-hidden="true" />
                        {busy === "create"
                          ? t("部屋を開いています…", "Opening your room…")
                          : t("部屋を作る", "Create a room")}
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
                            begin("join");
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
                          maxLength={64}
                        />
                        <button
                          type="submit"
                          disabled={!!busy || !endpoint || !callName.trim() || !invitation.trim()}
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
                            {localAvatar ? (
                              <NativeCallStage
                                className="peer-call-single-avatar"
                                layout="call"
                                participants={participants}
                              />
                            ) : (
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
                                  (signal?.role === "guest"
                                    ? remoteName
                                    : t("参加待ち", "Waiting for a participant"))}
                              </strong>
                              <small>
                                {guest
                                  ? t("着信しています", "Incoming call")
                                  : t(
                                      "相手の参加を待っています",
                                      "Waiting for the other participant",
                                    )}
                              </small>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="peer-call-waiting-copy">
                        {guest ? (
                          <>
                            <h3>{t(`${guest.name}から着信です`, `${guest.name} is calling`)}</h3>
                            {incomingActions}
                          </>
                        ) : signal?.state === "hosting" ? (
                          <>
                            <h3>{t("部屋を作成しました", "Your room is open")}</h3>
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
                                  void run("copy", async () => {
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
                                  })
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
                    <button type="button" className="peer-call-hangup" onClick={leave}>
                      <PhoneOff size={18} />
                      {t("キャンセル", "Cancel")}
                    </button>
                  </footer>
                </>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

import { isTauri } from "@tauri-apps/api/core";
import { MessageSquare, Pause, Phone, PhoneIncoming, PhoneOff, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { requestControlSurface, subscribeControlSurface } from "../control-surface";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import { captureAvatarMotion } from "./avatar-motion";
import { type NativeCallAvatarProps, NativeCallStage } from "./call-avatar";
import {
  type CallControlsAction,
  type CallEntrySnapshot,
  callControlsActionAllowed,
  useCallControlsWindow,
} from "./call-controls-window";
import { CallEntryView } from "./call-entry-view";
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
  const [open, setOpen] = useState(false);
  const layout = layoutFor(viewMode);
  const [room, setRoom] = useState<RoomCall | null>(null);
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [endpoint, setEndpoint] = useState(configuredRoomEndpoint);
  const owned = useRef<RoomCall | null>(null);
  const entryOwner = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  const action = useRef(0);
  const operationBusy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
    setCallName(name);
  }, [name]);
  useEffect(
    () =>
      subscribeControlSurface((surface) => {
        if (surface !== "call") setOpen(false);
      }),
    [],
  );
  const prefersDetached = isTauri() && (viewMode === "portrait" || viewMode === "companion");
  function showEntry() {
    requestControlSurface("call");
    setOpen(true);
  }
  function hideEntry() {
    setOpen(false);
    if (!detached) trigger.current?.focus();
  }

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
  const remoteName = signal?.remoteName || guest?.name || t("相手のYorishiro", "Other resident");
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
    entryOwner.current = crypto.randomUUID();
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

  function begin(kind: "create" | "join", selectedName: string, invitation = "") {
    void run(kind, async () => {
      entryOwner.current = crypto.randomUUID();
      owned.current?.leave();
      setCallName(selectedName);
      identity.current = { name: selectedName, avatarUrl };
      const next = new RoomCall({
        endpoint,
        name: selectedName,
        publicDescription,
        avatarUrl,
        getVoice,
        onChange: changed,
        onActiveChange: (value) => activeCallback.current?.(value),
      });
      owned.current = next;
      setRoom(next);
      roomCallback.current?.(next);
      if (kind === "create") await next.create();
      else await next.join(invitation.trim());
    });
  }

  function answer() {
    showEntry();
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
  const entryState: CallEntrySnapshot = {
    ownerKey: entryOwner.current,
    enabled: open && !connected,
    language: ja ? "ja" : "en",
    name: callName,
    localName,
    remoteName,
    active,
    connected,
    busy,
    status,
    error: callError || "",
    notice,
    endpoint,
    signalState: signal?.state || "idle",
    role: signal?.role || "",
    invitation: signal?.invitation || "",
    guest: guest ? { name: guest.name, requestId: guest.requestId } : null,
  };
  function handleEntryAction(intent: CallControlsAction, ownerKey: string = entryOwner.current) {
    if (ownerKey !== entryOwner.current) return;
    if (!callControlsActionAllowed(entryState, intent)) return;
    if (intent.type === "hide") {
      hideEntry();
      return;
    }
    if (intent.type === "cancel") {
      leave();
      return;
    }
    if (intent.type === "create" || intent.type === "join") {
      begin(intent.type, intent.name.trim(), intent.type === "join" ? intent.invitation : "");
      return;
    }
    if (intent.type === "accept") {
      answer();
      return;
    }
    if (intent.type === "decline") {
      void run("reject", () => room?.reject());
      return;
    }
    if (intent.type === "save-endpoint") {
      try {
        persistRoomEndpoint(intent.endpoint.trim());
        setEndpoint(configuredRoomEndpoint());
        setError("");
        setNotice(t("接続先を保存しました。", "Connection saved."));
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      }
      refresh((value) => value + 1);
    }
  }
  const entryWindow = useCallControlsWindow(
    { ...entryState, enabled: prefersDetached && open && !connected },
    handleEntryAction,
    () => setOpen(false),
  );
  const detached = prefersDetached && !entryWindow.unsupported;
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
        onClick={() => (connected ? leave() : open ? hideEntry() : showEntry())}
      >
        <Phone size={15} aria-hidden="true" />
        {active && <span className="peer-call-dot" aria-hidden="true" />}
      </button>
      {entryWindow.error && open && (
        <span className="peer-call-entry-window-error" role="alert">
          {entryWindow.unsupported
            ? t(
                "独立した通話ウィンドウを使うには、Yorishiroを再起動してください。現在は本体内に表示しています。",
                "Restart Yorishiro to use the separate call window. Showing controls in the main window for now.",
              )
            : entryWindow.error}
        </span>
      )}
      {connected &&
        createPortal(
          <aside
            className="peer-call-session-strip"
            aria-label={t("通話中", "In call")}
            data-no-window-drag
          >
            <span className="peer-call-session-status" role="status">
              <strong title={localName}>{localName}</strong>
              <small
                className="peer-call-session-partner"
                title={t(`${remoteName}と通話中`, `In call with ${remoteName}`)}
              >
                {!ja && <span>In call with</span>}
                <span className="peer-call-session-partner-name">{remoteName}</span>
                {ja && <span>と通話中</span>}
              </small>
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
              onClick={showEntry}
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
        !detached &&
        createPortal(
          <CallEntryView
            state={entryState}
            onAction={handleEntryAction}
            onHide={hideEntry}
            localAvatarPreview={
              localAvatar ? (
                <NativeCallStage
                  className="peer-call-single-avatar"
                  layout="call"
                  participants={participants}
                />
              ) : undefined
            }
          />,
          document.body,
        )}
    </>
  );
}

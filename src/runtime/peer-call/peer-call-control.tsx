import { isTauri } from "@tauri-apps/api/core";
import { MessageSquare, Pause, Phone, PhoneIncoming, PhoneOff, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { requestControlSurface, subscribeControlSurface } from "../control-surface";
import { getThreeRuntime } from "../three-runtime/three-runtime";
import { captureAvatarMotion } from "./avatar-motion";
import { CallAiDisclosure } from "./call-ai-disclosure";
import { type NativeCallAvatarProps, NativeCallStage } from "./call-avatar";
import {
  type CallControlsAction,
  type CallEntrySnapshot,
  callControlsActionAllowed,
  useCallControlsWindow,
} from "./call-controls-window";
import { CallEntryView } from "./call-entry-view";
import { CallPresence } from "./call-presence";
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
  onSessionStart?: (ownerKey: string, endCall: () => void) => void;
  controlsHost?: HTMLElement | null;
  onComposerHostChange?: (host: HTMLDivElement | null) => void;
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
function usesManagedCalls(endpoint: string) {
  try {
    return new URL(endpoint).pathname === "/v2/rooms";
  } catch {
    return false;
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
  onSessionStart,
  controlsHost,
  onComposerHostChange,
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
  const [presence, setPresence] = useState<CallPresence | null>(null);
  const [directTarget, setDirectTarget] = useState("");
  const [directIdentityId, setDirectIdentityId] = useState("");
  const owned = useRef<RoomCall | null>(null);
  const entryOwner = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  const action = useRef(0);
  const operationBusy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const identity = useRef({ name, avatarUrl });
  const presenceName = useRef(name);
  presenceName.current = name;
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
  useEffect(() => {
    // A legacy/custom broker can still be used explicitly. Managed presence lives
    // in the main window, independently of dialogs and display modes.
    if (!usesManagedCalls(endpoint)) {
      setPresence(null);
      return;
    }
    let disposed = false;
    const next = new CallPresence({
      endpoint,
      name: presenceName.current,
      onChange: () => {
        if (!disposed && mounted.current) refresh((value) => value + 1);
      },
      onIncoming: () => {
        if (disposed || !mounted.current) return;
        if ((owned.current && !owned.current.closed) || operationBusy.current) {
          if (next.incoming) next.decline(next.incoming.roomId);
          return;
        }
        requestControlSurface("call");
        setOpen(true);
      },
    });
    setPresence(next);
    void next.start().catch(() => {
      if (!disposed && mounted.current) refresh((value) => value + 1);
    });
    const close = () => next.close();
    window.addEventListener("pagehide", close);
    return () => {
      disposed = true;
      window.removeEventListener("pagehide", close);
      next.close();
    };
  }, [endpoint]);
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
    presence?.setPresence(callName.trim() || name, active || !!busy);
  }, [presence, callName, name, active, busy]);
  const incoming = !active ? presence?.incoming : null;
  useEffect(() => {
    if (connected) setOpen(false);
  }, [connected]);
  const signal = room?.signaling;
  const guest = active ? signal?.pendingGuest : null;
  const requestId = signal?.state === "pending" ? guest?.requestId : undefined;
  useIncomingRing(requestId || incoming?.roomId);
  const localName = active ? identity.current.name : callName.trim() || name;
  const localAvatar = active ? identity.current.avatarUrl : avatarUrl;
  const remoteName =
    signal?.remoteName ||
    guest?.name ||
    incoming?.name ||
    directTarget ||
    t("相手のYorishiro", "Other resident");
  const callError = error || room?.error || signal?.error;
  const status = incoming
    ? t("着信中", "Incoming call")
    : !active
      ? t("相手を選んで通話できます", "Choose someone to call")
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
            ? directTarget
              ? t("呼び出し中", "Calling")
              : t("招待中 · 相手を待っています", "Invitation open · Waiting for a guest")
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
    setDirectTarget("");
    setDirectIdentityId("");
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

  function begin(
    kind: "create" | "join",
    selectedName: string,
    invitation = "",
    targetIdentityId?: string,
  ) {
    void run(kind, async () => {
      owned.current?.leave();
      const ownerKey = crypto.randomUUID();
      entryOwner.current = ownerKey;
      setCallName(selectedName);
      setDirectIdentityId(targetIdentityId || "");
      setDirectTarget(
        targetIdentityId
          ? presence?.contacts.find((contact) => contact.identityId === targetIdentityId)?.name ||
              ""
          : "",
      );
      identity.current = { name: selectedName, avatarUrl };
      let next: RoomCall | null = null;
      try {
        onSessionStart?.(ownerKey, () => {
          if (entryOwner.current === ownerKey) leave();
        });
        next = new RoomCall({
          endpoint,
          name: selectedName,
          publicDescription,
          avatarUrl,
          getVoice,
          targetIdentityId,
          onChange: changed,
          onActiveChange: (value) => activeCallback.current?.(value),
        });
        owned.current = next;
        setRoom(next);
        roomCallback.current?.(next);
        if (kind === "create") await next.create();
        else await next.join(invitation.trim());
      } catch (error) {
        if (next && !next.closed) next.leave();
        // Setup can fail before a RoomCall exists. Restore the work session in
        // that case too, without closing a newer call after cancellation.
        if (mounted.current && entryOwner.current === ownerKey) {
          owned.current = null;
          setRoom(null);
          roomCallback.current?.(null);
        }
        throw error;
      }
    });
  }

  function answer() {
    showEntry();
    void run("accept", () => room?.accept());
  }

  function answerContact(roomId: string) {
    if (active || operationBusy.current || !presence) return;
    const invitation = presence.takeIncoming(roomId);
    if (!invitation) return;
    showEntry();
    begin("join", callName.trim() || name, invitation);
  }
  function declineContact(roomId: string) {
    if (active || operationBusy.current || presence?.incoming?.roomId !== roomId) return;
    presence.decline(roomId);
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
    invitation: directTarget ? "" : signal?.invitation || "",
    guest: guest ? { name: guest.name, requestId: guest.requestId } : null,
    contacts: presence?.contacts,
    incoming: incoming
      ? {
          roomId: incoming.roomId,
          identityId: incoming.identityId,
          name: incoming.name,
          expiresAt: incoming.expiresAt,
        }
      : null,
    presenceState: presence?.state,
    directTarget: active ? directTarget : "",
    failedContactId:
      !active &&
      callError &&
      presence?.contacts.some((contact) => contact.identityId === directIdentityId)
        ? directIdentityId
        : "",
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
    if (intent.type === "call-contact") {
      begin("create", intent.name.trim(), "", intent.identityId);
      return;
    }
    if (intent.type === "answer-contact") {
      answerContact(intent.roomId);
      return;
    }
    if (intent.type === "decline-contact") {
      declineContact(intent.roomId);
      return;
    }
    if (intent.type === "remove-contact") {
      presence?.removeContact(intent.identityId);
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
      {incoming &&
        !open &&
        createPortal(
          <aside
            className="peer-call-incoming-toast"
            aria-label={t("着信", "Incoming call")}
            aria-live="polite"
          >
            <PhoneIncoming size={21} aria-hidden="true" />
            <div>
              <strong>{incoming.name}</strong>
              <p>{t("通話を希望しています", "Is calling you")}</p>
            </div>
            <CallAiDisclosure language={language} />
            <div className="peer-call-actions">
              <button
                type="button"
                className="peer-call-secondary"
                disabled={!!busy}
                onClick={() => declineContact(incoming.roomId)}
              >
                {t("拒否", "Decline")}
              </button>
              <button
                type="button"
                className="peer-call-primary"
                disabled={!!busy}
                onClick={() => answerContact(incoming.roomId)}
              >
                {t("通話に出る", "Answer")}
              </button>
            </div>
          </aside>,
          document.body,
        )}
      {connected &&
        createPortal(
          <div
            className="peer-call-session-dock"
            data-placement={controlsHost ? "sidebar" : "floating"}
            data-no-window-drag
          >
            <div className="peer-call-composer-host" ref={onComposerHostChange} />
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
            </aside>
          </div>,
          controlsHost ?? document.body,
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
              <CallAiDisclosure language={language} />
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
                <strong>{directTarget || t("通話", "Call")}</strong>
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

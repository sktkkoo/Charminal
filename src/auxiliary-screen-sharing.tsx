import { LoaderCircle, MonitorUp, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  isPointerSettingsAction,
  latestAuxiliarySnapshot,
  listenAuxiliarySnapshot,
  type PublishedAuxiliarySnapshot,
  readAuxiliarySnapshot,
  requestAuxiliaryAction,
  type ScreenSharingAuxiliaryAction,
} from "./runtime/auxiliary-windows";
import { ScreenPointerToggle } from "./screen-pointer-toggle";
import "./screen-sharing-control.css";
import "./auxiliary-screen-sharing.css";

const text = {
  en: {
    title: "Screen sharing",
    description:
      "While sharing, the display updates periodically and when you start speaking in the call.",
    display: "Shared display",
    noDisplays: "No displays available",
    refresh: "Refresh displays",
    interval: "Periodic interval",
    seconds: (value: number) => `${value} seconds`,
    cost: "Screen sharing sends images and uses tokens. More frequent updates increase usage.",
    unavailable: "Choose an agent that supports screen sharing in the main window.",
    on: "Sharing",
    off: "Off",
    busy: "Sharing image…",
    waiting: "Waiting for the first image…",
    stopped: "Screen sharing is off.",
    lastViewed: "Last shared",
    cancel: "Cancel",
    start: "Start sharing",
    stop: "Stop sharing",
    clear: "Clear screen markers",
    markers:
      "Ask the resident to point to a part of the shared display. Markers expire automatically.",
    error: "Screen sharing failed. Check the main window for details.",
    pending: "Waiting for the main window…",
    closeNote: "Closing these controls keeps sharing running. Use Stop sharing to end it.",
  },
  ja: {
    title: "画面共有",
    description: "共有中は一定間隔と、通話で話し始めたときに画面を更新します。",
    display: "共有する画面",
    noDisplays: "共有できる画面がありません",
    refresh: "画面一覧を更新",
    interval: "定期更新の間隔",
    seconds: (value: number) => `${value}秒`,
    cost: "画面共有は画像の送信でトークンを消費します。更新が多いほど使用量が増えます。",
    unavailable: "メインウィンドウで画面共有に対応するエージェントを選択してください。",
    on: "共有中",
    off: "停止中",
    busy: "画像を共有中…",
    waiting: "最初の画像の共有を待っています…",
    stopped: "画面共有は停止しています。",
    lastViewed: "最終共有",
    cancel: "キャンセル",
    start: "共有を開始",
    stop: "共有を停止",
    clear: "画面の目印を消す",
    markers: "住人に共有画面の場所を指し示すよう話しかけてください。目印は時間が経つと消えます。",
    error: "画面共有でエラーが発生しました。詳細はメインウィンドウで確認してください。",
    pending: "メインウィンドウに接続しています…",
    closeNote:
      "このウィンドウを閉じても共有は続きます。終了するには「共有を停止」を押してください。",
  },
} as const;

/** This view only renders published state and requests actions from the main-window owner. */
export default function AuxiliaryScreenSharing() {
  const [published, setPublished] = useState<PublishedAuxiliarySnapshot | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [requesting, setRequesting] = useState(false);
  const [intervalDraft, setIntervalDraft] = useState(30);
  const [pointerDraft, setPointerDraft] = useState<{
    enabled: boolean;
    pointerRevision: string;
  } | null>(null);
  const pointerRequest = useRef(0);
  const latest = useRef(published);
  latest.current = published;
  const requestingRef = useRef(false);
  const state = published?.snapshot;
  const publishedInterval = state?.intervalSeconds;
  const labels = text[state?.language ?? (navigator.language.startsWith("ja") ? "ja" : "en")];

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const receive = (next: PublishedAuxiliarySnapshot) => {
      if (!disposed) setPublished((current) => latestAuxiliarySnapshot(current, next));
    };
    void listenAuxiliarySnapshot(receive)
      .then(async (cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const initial = await readAuxiliarySnapshot();
        if (initial) receive(initial);
      })
      .catch((failure: unknown) => {
        if (!disposed) setActionError(String(failure));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (publishedInterval !== undefined) setIntervalDraft(publishedInterval);
  }, [publishedInterval]);

  const request = async (action: ScreenSharingAuxiliaryAction) => {
    const current = latest.current;
    const independent = isPointerSettingsAction(action);
    if (!current || (!independent && requestingRef.current)) return;
    if (!independent) {
      requestingRef.current = true;
      setRequesting(true);
    }
    const pointerAttempt = independent ? ++pointerRequest.current : null;
    if (action.type === "set-pointers-enabled") {
      setPointerDraft({
        enabled: action.enabled,
        pointerRevision: current.snapshot.pointerRevision,
      });
    }
    setActionError(undefined);
    try {
      if (independent) {
        await requestAuxiliaryAction(current.version, action, current.snapshot.pointerRevision);
      } else {
        await requestAuxiliaryAction(current.version, action);
      }
    } catch (failure) {
      if (pointerAttempt !== null && pointerAttempt !== pointerRequest.current) return;
      if (pointerAttempt !== null) setPointerDraft(null);
      setActionError(String(failure));
      const refreshed = await readAuxiliarySnapshot().catch(() => null);
      if (refreshed) setPublished((previous) => latestAuxiliarySnapshot(previous, refreshed));
    } finally {
      if (!independent) {
        requestingRef.current = false;
        setRequesting(false);
      }
    }
  };

  if (!state) {
    return (
      <main className="screen-sharing-panel auxiliary-sharing">
        <h1>{labels.title}</h1>
        <p role="status">{labels.pending}</p>
        {actionError ? <p role="alert">{actionError}</p> : null}
      </main>
    );
  }

  const hasSelectedSource = state.sources.some((source) => source.id === state.sourceId);
  const canStart =
    state.available && state.pointersReady && hasSelectedSource && !state.busy && !requesting;
  const lastViewed =
    state.lastObservedAt === null
      ? null
      : new Date(state.lastObservedAt).toLocaleTimeString(
          state.language === "ja" ? "ja-JP" : "en-US",
        );
  const commitInterval = (value: string) => {
    const intervalSeconds = Number(value);
    if (intervalSeconds !== state.intervalSeconds) {
      void request({ type: "set-interval", intervalSeconds });
    }
  };

  return (
    <main className="screen-sharing-panel auxiliary-sharing">
      <header className="screen-sharing-heading">
        <MonitorUp size={18} aria-hidden="true" />
        <h1>{labels.title}</h1>
        <span className="screen-sharing-badge" data-active={state.active}>
          {state.active ? labels.on : labels.off}
        </span>
      </header>
      <p className="screen-sharing-description">{labels.description}</p>
      <label className="screen-sharing-label" htmlFor="shared-display">
        {labels.display}
      </label>
      <div className="screen-sharing-source-row">
        <select
          id="shared-display"
          value={hasSelectedSource ? (state.sourceId ?? "") : ""}
          disabled={state.active || state.busy || !state.available || requesting}
          onChange={(event) =>
            void request({ type: "select-source", sourceId: Number(event.currentTarget.value) })
          }
        >
          <option value="" disabled>
            {labels.noDisplays}
          </option>
          {state.sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="screen-sharing-icon-button"
          aria-label={labels.refresh}
          title={labels.refresh}
          disabled={state.active || state.busy || !state.available || requesting}
          onClick={() => void request({ type: "refresh-sources" })}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="screen-sharing-interval-heading">
        <label className="screen-sharing-label" htmlFor="viewing-interval">
          {labels.interval}
        </label>
        <output htmlFor="viewing-interval">{labels.seconds(intervalDraft)}</output>
      </div>
      <input
        id="viewing-interval"
        className="screen-sharing-slider"
        type="range"
        min={5}
        max={60}
        step={1}
        value={intervalDraft}
        aria-valuetext={labels.seconds(intervalDraft)}
        aria-describedby="sharing-cost"
        disabled={requesting}
        onChange={(event) => setIntervalDraft(Number(event.currentTarget.value))}
        onPointerUp={(event) => commitInterval(event.currentTarget.value)}
        onKeyUp={(event) => commitInterval(event.currentTarget.value)}
        onBlur={(event) => commitInterval(event.currentTarget.value)}
      />
      <div className="screen-sharing-range-labels" aria-hidden="true">
        <span>{labels.seconds(5)}</span>
        <span>{labels.seconds(60)}</span>
      </div>
      <p className="screen-sharing-cost" id="sharing-cost">
        {labels.cost}
      </p>
      <ScreenPointerToggle
        enabled={
          pointerDraft && state.pointerRevision === pointerDraft.pointerRevision
            ? pointerDraft.enabled
            : state.pointersEnabled
        }
        ready={state.pointersReady}
        language={state.language}
        onChange={(enabled) => void request({ type: "set-pointers-enabled", enabled })}
        onRetry={state.hasError ? () => void request({ type: "retry-pointers" }) : undefined}
      />
      {!state.available ? <p className="screen-sharing-description">{labels.unavailable}</p> : null}
      {state.hasError || actionError ? (
        <p className="screen-sharing-error" role="alert">
          {actionError ?? labels.error}
        </p>
      ) : null}
      <p className="screen-sharing-status" role="status" aria-live="polite">
        {state.busy ? (
          <>
            <LoaderCircle size={13} className="screen-sharing-spinner" aria-hidden="true" />
            {labels.busy}
          </>
        ) : state.active ? (
          lastViewed ? (
            `${labels.lastViewed}: ${lastViewed}`
          ) : (
            labels.waiting
          )
        ) : (
          labels.stopped
        )}
      </p>
      <button
        type="button"
        className="screen-sharing-action"
        data-active={state.active}
        disabled={state.active || state.busy ? requesting : !canStart}
        onClick={() => void request({ type: state.active || state.busy ? "stop" : "start" })}
      >
        {state.active ? labels.stop : state.busy ? labels.cancel : labels.start}
      </button>
      <div className="auxiliary-sharing-markers">
        <button
          type="button"
          className="screen-sharing-action"
          data-active="true"
          disabled={!state.active || requesting}
          onClick={() => void request({ type: "clear-annotations" })}
        >
          {labels.clear}
        </button>
        <p className="screen-sharing-description">{labels.markers}</p>
      </div>
      <p className="screen-sharing-description auxiliary-sharing-close-note">{labels.closeNote}</p>
    </main>
  );
}

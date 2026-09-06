import { ExternalLink, LoaderCircle, MonitorUp, RefreshCw, X } from "lucide-react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { ScreenPointerToggle } from "./screen-pointer-toggle";
import "./screen-sharing-control.css";

export interface ScreenSharingControlProps {
  readonly available: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly pointersEnabled: boolean;
  readonly pointersReady: boolean;
  readonly intervalSeconds: number;
  readonly sources: readonly { readonly id: number; readonly name: string }[];
  readonly sourceId: number | null;
  readonly error?: string;
  readonly lastObservedAt?: number;
  readonly onIntervalChange: (value: number) => void;
  readonly onSourceChange: (id: number) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onClearAnnotations: () => void;
  readonly onRetryPointers: () => void;
  readonly onPointersEnabledChange: (enabled: boolean) => void;
  readonly onRefreshSources: () => void;
  readonly onOpenAuxiliary?: () => Promise<void>;
  readonly language?: string;
}

const strings = {
  en: {
    title: "Screen sharing",
    activeTitle: "Screen sharing on",
    close: "Close screen sharing settings",
    openAuxiliary: "Open screen sharing in a separate window",
    display: "Display",
    chooseDisplay: "Choose a display",
    noDisplays: "No displays available",
    refresh: "Refresh displays",
    interval: "Periodic interval",
    seconds: (value: number) => `${value} seconds`,
    cost: "Sending images periodically uses many tokens.",
    unavailable: "Select an agent that supports screen sharing to start.",
    on: "Sharing",
    off: "Off",
    busy: "Sharing image…",
    waiting: "Waiting for the first image…",
    lastViewed: "Last shared",
    cancel: "Cancel",
    start: "Start sharing",
    stop: "Stop sharing",
    clearAnnotations: "Clear pointing",
  },
  ja: {
    title: "画面共有",
    activeTitle: "画面共有中",
    close: "画面共有の設定を閉じる",
    openAuxiliary: "画面共有を別ウィンドウで開く",
    display: "画面選択",
    chooseDisplay: "画面を選択",
    noDisplays: "共有できる画面がありません",
    refresh: "画面一覧を更新",
    interval: "定期更新の間隔",
    seconds: (value: number) => `${value}秒`,
    cost: "画像の定期送信ではトークンを多く消費します。",
    unavailable: "画面共有に対応するエージェントを選択してください。",
    on: "共有中",
    off: "停止中",
    busy: "画像を共有中…",
    waiting: "最初の画像の共有を待っています…",
    lastViewed: "最終共有",
    cancel: "キャンセル",
    start: "共有を開始",
    stop: "共有を停止",
    clearAnnotations: "指し示しを消す",
  },
} as const;

/** Controlled screen-sharing settings. Opening the panel never starts capture. */
export function ScreenSharingControl({
  available,
  active,
  busy,
  pointersEnabled,
  pointersReady,
  intervalSeconds,
  sources,
  sourceId,
  error,
  lastObservedAt,
  onIntervalChange,
  onSourceChange,
  onStart,
  onStop,
  onClearAnnotations,
  onPointersEnabledChange,
  onRetryPointers,
  onRefreshSources,
  onOpenAuxiliary,
  language = "en",
}: ScreenSharingControlProps) {
  const [open, setOpen] = useState(false);
  const [openingAuxiliary, setOpeningAuxiliary] = useState(false);
  const [auxiliaryError, setAuxiliaryError] = useState<string>();
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const openingAuxiliaryRef = useRef(false);
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();
  const displayId = useId();
  const intervalId = useId();
  const costId = useId();
  const isJapanese = language.startsWith("ja");
  const labels = strings[isJapanese ? "ja" : "en"];
  const displayError = auxiliaryError ?? error;
  const hasSelectedSource = sources.some((source) => source.id === sourceId);
  const canStart = available && pointersReady && hasSelectedSource && !busy;
  const lastViewed =
    lastObservedAt !== undefined && Number.isFinite(lastObservedAt)
      ? new Date(lastObservedAt).toLocaleTimeString(isJapanese ? "ja-JP" : "en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : null;

  const openPanel = () => {
    setOpen(true);
    if (!active) onRefreshSources();
  };

  const openAuxiliary = async () => {
    if (!onOpenAuxiliary || openingAuxiliaryRef.current) return;
    openingAuxiliaryRef.current = true;
    setOpeningAuxiliary(true);
    setAuxiliaryError(undefined);
    try {
      await onOpenAuxiliary();
      setOpen(false);
    } catch (failure) {
      setAuxiliaryError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      openingAuxiliaryRef.current = false;
      setOpeningAuxiliary(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const positionPanel = () => {
      const width = Math.min(310, Math.max(0, window.innerWidth - 24));
      const rect = triggerRef.current?.getBoundingClientRect();
      const top = Math.min((rect?.bottom ?? 32) + 8, Math.max(12, window.innerHeight - 100));
      setPanelStyle({
        left: Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - width - 12)),
        top,
        width,
        maxHeight: Math.max(0, window.innerHeight - top - 12),
      });
    };
    positionPanel();
    window.addEventListener("resize", positionPanel);
    closeRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <fieldset
      className="screen-sharing-control"
      aria-label={labels.title}
      ref={rootRef}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`title-bar-button screen-sharing-trigger${active || open ? " is-active" : ""}`}
        data-sharing-active={active}
        aria-label={active ? labels.activeTitle : labels.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={displayError ?? (active ? labels.activeTitle : labels.title)}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) openPanel();
          }
        }}
      >
        <MonitorUp size={15} strokeWidth={1.8} aria-hidden="true" />
        {active ? <span className="screen-sharing-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          id={panelId}
          className="screen-sharing-panel"
          style={panelStyle}
          role="dialog"
          aria-labelledby={titleId}
        >
          <div className="screen-sharing-heading">
            <h2 id={titleId}>{labels.title}</h2>
            <span className="screen-sharing-badge" data-active={active}>
              {active ? labels.on : labels.off}
            </span>
            {onOpenAuxiliary ? (
              <button
                type="button"
                className="screen-sharing-icon-button"
                aria-label={labels.openAuxiliary}
                aria-busy={openingAuxiliary}
                title={labels.openAuxiliary}
                disabled={openingAuxiliary}
                onClick={() => void openAuxiliary()}
              >
                {openingAuxiliary ? (
                  <LoaderCircle size={14} className="screen-sharing-spinner" aria-hidden="true" />
                ) : (
                  <ExternalLink size={14} aria-hidden="true" />
                )}
              </button>
            ) : null}
            <button
              ref={closeRef}
              type="button"
              className="screen-sharing-icon-button"
              aria-label={labels.close}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <label className="screen-sharing-label" htmlFor={displayId}>
            {labels.display}
          </label>
          <div className="screen-sharing-source-row">
            <select
              id={displayId}
              value={hasSelectedSource ? (sourceId ?? "") : ""}
              disabled={active || busy || !available || sources.length === 0}
              onChange={(event) => {
                if (event.currentTarget.value !== "") {
                  onSourceChange(Number(event.currentTarget.value));
                }
              }}
            >
              <option value="" disabled>
                {sources.length > 0 ? labels.chooseDisplay : labels.noDisplays}
              </option>
              {sources.map((source) => (
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
              disabled={active || busy || !available}
              onClick={onRefreshSources}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="screen-sharing-interval-heading">
            <label className="screen-sharing-label" htmlFor={intervalId}>
              {labels.interval}
            </label>
            <output htmlFor={intervalId}>{labels.seconds(intervalSeconds)}</output>
          </div>
          <input
            id={intervalId}
            className="screen-sharing-slider"
            type="range"
            min={20}
            max={60}
            step={1}
            value={intervalSeconds}
            aria-valuetext={labels.seconds(intervalSeconds)}
            aria-describedby={costId}
            onChange={(event) => onIntervalChange(Number(event.currentTarget.value))}
          />
          <div className="screen-sharing-range-labels" aria-hidden="true">
            <span>{labels.seconds(20)}</span>
            <span>{labels.seconds(60)}</span>
          </div>
          <p className="screen-sharing-cost" id={costId}>
            {labels.cost}
          </p>
          <ScreenPointerToggle
            enabled={pointersEnabled}
            ready={pointersReady}
            language={language}
            onChange={onPointersEnabledChange}
            onRetry={error ? onRetryPointers : undefined}
          />
          {!available ? <p className="screen-sharing-description">{labels.unavailable}</p> : null}
          {displayError ? (
            <p className="screen-sharing-error" role="alert">
              {displayError}
            </p>
          ) : active || busy ? (
            <div className="screen-sharing-status" role="status" aria-live="polite">
              {busy ? (
                <>
                  <LoaderCircle size={13} className="screen-sharing-spinner" aria-hidden="true" />
                  <span>{labels.busy}</span>
                </>
              ) : lastViewed ? (
                <span>
                  {labels.lastViewed}: {lastViewed}
                </span>
              ) : (
                <span>{labels.waiting}</span>
              )}
            </div>
          ) : null}
          {active ? (
            <button
              type="button"
              className="screen-sharing-action screen-sharing-clear"
              onClick={onClearAnnotations}
            >
              {labels.clearAnnotations}
            </button>
          ) : null}
          <button
            type="button"
            className="screen-sharing-action"
            data-active={active}
            disabled={!active && !busy && !canStart}
            aria-describedby={!active ? costId : undefined}
            onClick={active || busy ? onStop : onStart}
          >
            {active ? labels.stop : busy ? labels.cancel : labels.start}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

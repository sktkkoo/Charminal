import { Camera, ExternalLink, PanelBottom, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./camera-preview.css";

export interface CameraPreviewProps {
  readonly stream?: MediaStream;
  readonly imageDataUrl?: string;
  readonly detached?: boolean;
  readonly opening?: boolean;
  readonly error?: string;
  readonly onDetach?: () => void;
  readonly onAttach?: () => void;
  readonly lastCapturedAt?: number;
  readonly lastSharedAt?: number;
  readonly language?: string;
  readonly onStop: () => void;
}

/** Local-only monitor of the already-owned camera. Unmount never stops the capture owner's tracks. */
export function CameraPreview({
  stream,
  imageDataUrl,
  detached = false,
  opening = false,
  error,
  onDetach,
  onAttach,
  lastCapturedAt,
  lastSharedAt,
  language = "en",
  onStop,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const japanese = language.startsWith("ja");
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    let disposed = false;
    video.srcObject = stream;
    setPlaybackBlocked(false);
    void video.play().catch(() => {
      if (!disposed) setPlaybackBlocked(true);
    });
    return () => {
      disposed = true;
      video.pause();
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <section
      className={`camera-preview${detached ? " camera-preview--detached" : ""}`}
      data-no-window-drag
      aria-label={japanese ? "カメラプレビュー" : "Camera preview"}
    >
      <header>
        <Camera size={13} aria-hidden="true" />
        <span>{japanese ? "カメラ" : "Camera"}</span>
        <span className="camera-preview-live">LIVE</span>
        {onDetach || onAttach ? (
          <button
            type="button"
            className="camera-preview-window-button"
            disabled={opening}
            onClick={detached ? onAttach : onDetach}
            aria-label={
              detached
                ? japanese
                  ? "ヨリシロ内に戻す"
                  : "Return to Yorishiro"
                : japanese
                  ? "別ウィンドウで開く"
                  : "Open in separate window"
            }
            title={
              detached
                ? japanese
                  ? "ヨリシロ内に戻す"
                  : "Return to Yorishiro"
                : japanese
                  ? "別ウィンドウで開く"
                  : "Open in separate window"
            }
          >
            {detached ? (
              <PanelBottom size={13} aria-hidden="true" />
            ) : (
              <ExternalLink size={13} aria-hidden="true" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="camera-preview-stop"
          onClick={onStop}
          aria-label={japanese ? "カメラ共有を停止" : "Stop camera sharing"}
          title={japanese ? "カメラ共有を停止" : "Stop camera sharing"}
        >
          <Square size={10} fill="currentColor" aria-hidden="true" />
          <span>{japanese ? "停止" : "Stop"}</span>
        </button>
      </header>
      <div className="camera-preview-image">
        {/* The stream is explicitly video-only; there is no audio to caption. */}
        {stream ? (
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label={japanese ? "共有中のカメラ映像" : "Shared camera view"}
          />
        ) : imageDataUrl ? (
          <img src={imageDataUrl} alt={japanese ? "共有中のカメラ映像" : "Shared camera view"} />
        ) : null}
        {lastCapturedAt !== undefined ? (
          <span key={lastCapturedAt} className="camera-preview-capture-cue" aria-hidden="true">
            <span className="camera-preview-flash" />
          </span>
        ) : null}
        {playbackBlocked ? (
          <button
            className="camera-preview-resume"
            type="button"
            onClick={() => {
              void videoRef.current
                ?.play()
                .then(() => setPlaybackBlocked(false))
                .catch(() => {});
            }}
          >
            {japanese ? "プレビューを再生" : "Play preview"}
          </button>
        ) : null}
      </div>
      <footer>
        {error ? <span role="alert">{error}</span> : null}
        <span>
          {lastCapturedAt === undefined
            ? japanese
              ? "撮影待ち"
              : "Waiting for capture"
            : lastSharedAt !== undefined && lastSharedAt >= lastCapturedAt
              ? japanese
                ? "静止画を共有しました"
                : "Snapshot shared"
              : japanese
                ? "静止画を撮影しました"
                : "Snapshot captured"}
        </span>
      </footer>
    </section>
  );
}

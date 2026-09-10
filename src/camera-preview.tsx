import { Camera, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./camera-preview.css";

export interface CameraPreviewProps {
  readonly stream: MediaStream;
  readonly lastCapturedAt?: number;
  readonly lastSharedAt?: number;
  readonly language?: string;
  readonly onStop: () => void;
}

/** Local-only monitor of the already-owned camera. Unmount never stops the capture owner's tracks. */
export function CameraPreview({
  stream,
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
    if (!video) return;
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
      className="camera-preview"
      data-no-window-drag
      aria-label={japanese ? "カメラプレビュー" : "Camera preview"}
    >
      <header>
        <Camera size={13} aria-hidden="true" />
        <span>{japanese ? "カメラ" : "Camera"}</span>
        <span className="camera-preview-live">LIVE</span>
        <button
          type="button"
          onClick={onStop}
          aria-label={japanese ? "カメラ共有を停止" : "Stop camera sharing"}
          title={japanese ? "カメラ共有を停止" : "Stop camera sharing"}
        >
          <Square size={12} aria-hidden="true" />
        </button>
      </header>
      <div className="camera-preview-image">
        {/* The stream is explicitly video-only; there is no audio to caption. */}
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label={japanese ? "共有中のカメラ映像" : "Shared camera view"}
        />
        {lastCapturedAt !== undefined ? (
          <span key={lastCapturedAt} className="camera-preview-flash" aria-hidden="true">
            <span>{japanese ? "撮影" : "Captured"}</span>
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

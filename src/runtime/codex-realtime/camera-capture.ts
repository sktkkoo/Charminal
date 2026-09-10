/** Camera ownership stays in the main WebView; enumerating devices never requests access. */
export interface CameraSource {
  readonly id: number;
  readonly name: string;
  readonly deviceId?: string;
}

const deviceIds = new Map<string, number>();
let nextDeviceId = 1;

export async function listCameraSources(): Promise<CameraSource[]> {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices.enumerateDevices)
    throw new Error("Camera access is not available.");
  const devices = await navigator.mediaDevices.enumerateDevices();
  return [
    { id: 0, name: "Default camera" },
    ...devices
      .filter((device) => device.kind === "videoinput" && device.deviceId)
      .map((device) => {
        let id = deviceIds.get(device.deviceId);
        if (id === undefined) {
          id = nextDeviceId++;
          deviceIds.set(device.deviceId, id);
        }
        return { id, name: device.label || `Camera ${id}`, deviceId: device.deviceId };
      }),
  ];
}

export interface CameraCapture {
  readonly stream: MediaStream;
  capture(): { dataUrl: string; width: number; height: number; capturedAt: number };
  close(): void;
}

/** Start is explicitly invoked by the user. A late permission grant cannot retain a stream. */
export async function openCamera(
  deviceId: string | undefined,
  signal: AbortSignal,
  onEnded: () => void,
): Promise<CameraCapture> {
  signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  if (!stream.getVideoTracks().some((track) => track.readyState === "live")) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("The camera did not provide a live video track.");
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    for (const track of stream.getTracks()) {
      track.removeEventListener("ended", onEnded);
      track.stop();
    }
    video.pause();
    video.srcObject = null;
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  for (const track of stream.getVideoTracks()) track.addEventListener("ended", onEnded);
  video.srcObject = stream;
  try {
    // Waiting for permission is cancellable at the owner. Waiting for a video frame
    // additionally has a deadline so an unavailable camera does not hang Start.
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", ready);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const ready = () => finish();
      const aborted = () => finish(new DOMException("Camera sharing cancelled", "AbortError"));
      const timer = setTimeout(
        () => finish(new Error("The camera did not provide an image. Try another camera.")),
        15_000,
      );
      video.addEventListener("loadeddata", ready, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      void video.play().then(() => {
        if (video.readyState >= 2) ready();
      }, finish);
    });
    signal.throwIfAborted();
    return {
      stream,
      close,
      capture: () => {
        if (closed || signal.aborted)
          throw new DOMException("Camera sharing cancelled", "AbortError");
        if (!video.videoWidth || !video.videoHeight)
          throw new Error("The camera image is not available.");
        const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not capture the camera image.");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return {
          dataUrl: canvas.toDataURL("image/jpeg", 0.85),
          width: canvas.width,
          height: canvas.height,
          capturedAt: Date.now(),
        };
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

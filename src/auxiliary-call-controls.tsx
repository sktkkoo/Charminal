import { useEffect, useRef, useState } from "react";
import {
  type CallControlsAction,
  listenCallControls,
  type PublishedCallControls,
  readCallControls,
  requestCallControls,
} from "./runtime/peer-call/call-controls-window";
import { CallEntryView } from "./runtime/peer-call/call-entry-view";

/** Bundled UI only. Importing this view never starts an agent, microphone or RoomCall. */
export default function AuxiliaryCallControls() {
  const [published, setPublished] = useState<PublishedCallControls | null>(null);
  const [error, setError] = useState("");
  const latest = useRef(published);
  latest.current = published;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const receive = (next: PublishedCallControls) => {
      if (!disposed)
        setPublished((current) => (!current || next.version > current.version ? next : current));
    };
    void listenCallControls(receive)
      .then(async (cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const initial = await readCallControls();
        if (initial) receive(initial);
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const request = async (action: CallControlsAction) => {
    const current = latest.current;
    if (!current?.snapshot.enabled) return;
    await requestCallControls(current.version, action);
  };
  if (!published)
    return (
      <p role={error ? "alert" : "status"}>
        {error || "Yorishiroに接続しています… / Connecting to Yorishiro…"}
      </p>
    );
  return (
    <CallEntryView
      state={{ ...published.snapshot, error: error || published.snapshot.error }}
      detached
      onAction={request}
      onHide={() => void request({ type: "hide" }).catch((error) => setError(String(error)))}
    />
  );
}

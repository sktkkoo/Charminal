import { useEffect, useRef } from "react";

/** Choose once per sharing session; view changes and fresh frames do not move the preview. */
export function useInitialPreviewDestination({
  sessionKey,
  ready,
  initiallyDetached,
  detach,
}: {
  sessionKey: unknown;
  ready: boolean;
  initiallyDetached: boolean;
  detach: () => Promise<void>;
}) {
  const session = useRef<{ key: unknown; external: boolean; applied: boolean } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (sessionKey == null) {
      session.current = undefined;
      return;
    }
    if (session.current?.key !== sessionKey) {
      session.current = { key: sessionKey, external: initiallyDetached, applied: false };
    }
    if (!ready || session.current.applied) return;
    session.current.applied = true;
    if (session.current.external) void detach().catch(() => {});
  }, [sessionKey, ready, initiallyDetached, detach]);
}

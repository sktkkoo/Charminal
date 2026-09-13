import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionTabManager } from "../session-tabs/session-tab-manager";
import type { SessionId } from "../sessions/types";

export interface CallSessionOptions {
  /** Closing the call tab is a request to leave the corresponding call. */
  readonly onCloseRequested: (ownerKey: string) => void;
}

interface OwnedCallSession {
  readonly ownerKey: string;
  readonly sessionId: SessionId;
}

/**
 * Owns only the ephemeral call presentation. NativeCallAgent owns its separate,
 * fresh voice session. Call begin before accepting/admitting or starting media;
 * a thrown setup error must abort admission. End on leave, cancel, or failure.
 */
export function useCallSession(manager: SessionTabManager, options: CallSessionOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ownedRef = useRef<OwnedCallSession | null>(null);
  const [sessionId, setSessionId] = useState<SessionId | null>(null);

  useEffect(() => {
    const unsubscribe = manager.subscribe((state) => {
      const owned = ownedRef.current;
      if (!owned || state.sessions.includes(owned.sessionId)) return;
      ownedRef.current = null;
      setSessionId(null);
      optionsRef.current.onCloseRequested(owned.ownerKey);
    });
    return () => {
      unsubscribe();
      const owned = ownedRef.current;
      ownedRef.current = null;
      if (owned) manager.closeCallSession(owned.sessionId);
    };
  }, [manager]);

  const begin = useCallback(
    (ownerKey: string): SessionId => {
      if (!ownerKey) throw new Error("A call session requires an owner.");
      const owned = ownedRef.current;
      if (owned) {
        if (owned.ownerKey !== ownerKey) throw new Error("Another call session is already open.");
        return owned.sessionId;
      }
      const nextId = manager.openCallSession();
      ownedRef.current = { ownerKey, sessionId: nextId };
      setSessionId(nextId);
      return nextId;
    },
    [manager],
  );

  const end = useCallback(
    (ownerKey?: string): void => {
      const owned = ownedRef.current;
      if (!owned || (ownerKey !== undefined && ownerKey !== owned.ownerKey)) return;
      // Clear ownership before notifying subscribers so our own cleanup does not
      // become another leave request, or end a newer call from a stale callback.
      ownedRef.current = null;
      manager.closeCallSession(owned.sessionId);
      setSessionId(null);
    },
    [manager],
  );

  return { sessionId, begin, end };
}

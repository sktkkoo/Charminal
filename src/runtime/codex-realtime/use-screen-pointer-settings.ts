import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ScreenPointerSetting,
  screenAnnotationSetEnabled,
} from "../../bindings/tauri-commands";
import { getAnnotationDocument } from "./use-screen-sharing";

interface Options {
  /** Null until the existing App configuration read completes. */
  readonly initialEnabled: boolean | null;
  readonly persist: (enabled: boolean) => Promise<void>;
  readonly notify: (enabled: boolean, pointerEpoch?: number) => Promise<void>;
}

// Native rejects older revisions and previous WebView documents. Keep this
// monotonic across hook remounts, using the same document epoch as sharing Start.
let nextRevision = 0;

/** Independent from capture: disabling markers never waits for image delivery or config I/O. */
export function useScreenPointerSettings({ initialEnabled, persist, notify }: Options) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const request = useRef(0);
  const initializing = useRef<Promise<void> | null>(null);
  const applied = useRef<(ScreenPointerSetting & { revision: number }) | null>(null);
  const latest = useRef({ persist, notify });
  latest.current = { persist, notify };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      initializing.current = null;
      request.current = ++nextRevision;
    };
  }, []);

  const apply = useCallback(async (value: boolean, save: boolean) => {
    const revision = ++nextRevision;
    request.current = revision;
    setEnabled(value);
    setError(undefined);
    try {
      const documentId = await getAnnotationDocument();
      if (!mounted.current || request.current !== revision) return;
      const accepted = await screenAnnotationSetEnabled(documentId, revision, value);
      if (!mounted.current) return;
      if (!applied.current || applied.current.revision < revision) {
        applied.current = { revision, ...accepted };
      }
      if (request.current !== revision) return;
      setEnabled(accepted.enabled);
      setReady(true);
      // Neither model metadata nor the shared config write queue blocks OFF.
      void latest.current.notify(accepted.enabled, accepted.pointerEpoch).catch(() => {
        if (mounted.current && request.current === revision) {
          setError("Could not update the agent's screen marker setting.");
        }
      });
      if (save) {
        void latest.current.persist(accepted.enabled).catch(() => {
          if (mounted.current && request.current === revision) {
            setError("Screen marker setting changed, but could not be saved.");
          }
        });
      }
    } catch {
      if (mounted.current && request.current === revision) {
        setEnabled(applied.current?.enabled ?? false);
        setError("Could not update the screen marker setting.");
      }
    }
  }, []);

  const retry = useCallback(() => {
    if (initialEnabled === null || ready) return Promise.resolve();
    if (initializing.current) return initializing.current;
    const pending = apply(initialEnabled, false);
    initializing.current = pending;
    void pending.finally(() => {
      if (initializing.current === pending) initializing.current = null;
    });
    return pending;
  }, [initialEnabled, ready, apply]);

  useEffect(() => {
    void retry();
  }, [retry]);

  const change = useCallback(
    (value: boolean) => {
      if (!ready) return Promise.resolve();
      return apply(value, true);
    },
    [apply, ready],
  );

  return { enabled, ready, error, setEnabled: change, retry };
}

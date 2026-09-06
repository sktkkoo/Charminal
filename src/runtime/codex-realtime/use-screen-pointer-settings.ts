import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ScreenPointerSetting,
  screenAnnotationSetEnabled,
} from "../../bindings/tauri-commands";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { parseConfig } from "../user-pack-loader/config";
import { readYorishiroConfigText } from "../user-pack-loader/yorishiro-io";
import { getAnnotationDocument } from "./use-screen-sharing";

interface Options {
  readonly persist: (enabled: boolean) => Promise<void>;
  readonly notify: (enabled: boolean, pointerEpoch?: number) => Promise<void>;
}

// App's runtime can survive a discarded initial render or a later remount.
// Keep preferences independent of its bootstrap and any captured React setter.
// Remember pending user choices and accepted changes while config writes are queued.
const getPreference = () =>
  getOrInit(KEYS.SCREEN_POINTER_SETTINGS, () => ({
    enabled: null as boolean | null,
    pending: null as Promise<boolean> | null,
    nextRevision: 0,
    acceptedRevision: 0,
    pendingIntent: null as { revision: number; enabled: boolean } | null,
  }));

function readInitialPreference(): Promise<boolean> {
  const preference = getPreference();
  if (preference.pendingIntent) return Promise.resolve(preference.pendingIntent.enabled);
  if (preference.enabled !== null) return Promise.resolve(preference.enabled);
  if (preference.pending) return preference.pending;
  const pending = readYorishiroConfigText()
    .then(
      (text) =>
        preference.pendingIntent?.enabled ??
        preference.enabled ??
        parseConfig(text).screenPointersEnabled,
    )
    .finally(() => {
      if (preference.pending === pending) preference.pending = null;
    });
  preference.pending = pending;
  return pending;
}

/** Independent from capture: disabling markers never waits for image delivery or config I/O. */
export function useScreenPointerSettings({ persist, notify }: Options) {
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
      request.current = ++getPreference().nextRevision;
    };
  }, []);

  const apply = useCallback(async (value: boolean, save: boolean) => {
    const preference = getPreference();
    const revision = ++preference.nextRevision;
    request.current = revision;
    if (save) preference.pendingIntent = { revision, enabled: value };
    setEnabled(value);
    setError(undefined);
    try {
      const documentId = await getAnnotationDocument();
      if (!mounted.current || request.current !== revision) return;
      const accepted = await screenAnnotationSetEnabled(documentId, revision, value);
      if (preference.acceptedRevision < revision) {
        preference.enabled = accepted.enabled;
        preference.acceptedRevision = revision;
      }
      // A remount may resynchronize the same intent before the original reply.
      // Either accepted reply can save it once; obsolete opposite replies cannot.
      const intent = preference.pendingIntent;
      if (intent && revision >= intent.revision && accepted.enabled === intent.enabled) {
        preference.pendingIntent = null;
        void latest.current.persist(accepted.enabled).catch(() => {
          if (mounted.current && request.current === revision) {
            setError("Screen marker setting changed, but could not be saved.");
          }
        });
      }
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
    } catch {
      if (mounted.current && request.current === revision) {
        if (preference.pendingIntent?.revision === revision) preference.pendingIntent = null;
        setEnabled(applied.current?.enabled ?? preference.enabled ?? false);
        setError("Could not update the screen marker setting.");
      }
    }
  }, []);

  const retry = useCallback(() => {
    if (ready) return Promise.resolve();
    if (initializing.current) return initializing.current;
    const revision = ++getPreference().nextRevision;
    request.current = revision;
    setError(undefined);
    const pending = readInitialPreference()
      .then((value) => {
        if (mounted.current && request.current === revision) return apply(value, false);
      })
      .catch(() => {
        if (mounted.current && request.current === revision) {
          setError("Could not read the screen marker setting.");
        }
      });
    initializing.current = pending;
    void pending.finally(() => {
      if (initializing.current === pending) initializing.current = null;
    });
    return pending;
  }, [ready, apply]);

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

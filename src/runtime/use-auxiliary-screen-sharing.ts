import { useCallback, useEffect, useRef, useState } from "react";
import { ScreenSharingAuxiliaryHost, type ScreenSharingAuxiliaryModel } from "./auxiliary-windows";

export function useAuxiliaryScreenSharing(model: ScreenSharingAuxiliaryModel) {
  const host = useRef<ScreenSharingAuxiliaryHost | null>(null);
  const latest = useRef(model);
  latest.current = model;
  const [error, setError] = useState<string>();

  useEffect(() => {
    const bridge = new ScreenSharingAuxiliaryHost((failure) => setError(String(failure)));
    host.current = bridge;
    bridge.update(latest.current);
    return () => {
      if (host.current === bridge) host.current = null;
      bridge.dispose();
    };
  }, []);

  useEffect(() => {
    host.current?.update(model);
  }, [model]);

  const open = useCallback(async () => {
    setError(undefined);
    try {
      await host.current?.open();
    } catch (failure) {
      setError(String(failure));
    }
  }, []);

  return { open, error };
}

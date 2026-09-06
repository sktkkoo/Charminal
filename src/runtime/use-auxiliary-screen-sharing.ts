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
    const bridge = host.current;
    setError(undefined);
    try {
      if (!bridge) throw new Error("Screen sharing controls are not ready.");
      await bridge.open();
      if (host.current !== bridge) throw new Error("Screen sharing controls changed. Try again.");
    } catch (failure) {
      if (host.current === bridge) setError(String(failure));
      throw failure;
    }
  }, []);

  return { open, error };
}

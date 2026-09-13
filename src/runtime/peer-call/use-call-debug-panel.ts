import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface CallDebugPanelOptions {
  readonly callActive: boolean;
  readonly hidden: boolean;
  readonly setHidden: Dispatch<SetStateAction<boolean>>;
}

/** Keeps shared scene controls closed for the whole call, including programmatic open requests. */
export function useCallDebugPanel({ callActive, hidden, setHidden }: CallDebugPanelOptions) {
  const [noticeVisible, setNoticeVisible] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearNoticeTimer = useCallback(() => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
  }, []);

  useEffect(() => {
    if (callActive) {
      // Persist the closure so ending the call cannot reopen a previously visible panel.
      if (!hidden) setHidden(true);
    } else {
      clearNoticeTimer();
      setNoticeVisible(false);
    }
  }, [callActive, hidden, setHidden, clearNoticeTimer]);

  useEffect(() => clearNoticeTimer, [clearNoticeTimer]);

  const toggle = useCallback(() => {
    if (!callActive) {
      setHidden((previous) => !previous);
      return;
    }
    clearNoticeTimer();
    setNoticeVisible(true);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNoticeVisible(false);
    }, 4_000);
  }, [callActive, setHidden, clearNoticeTimer]);

  return {
    // Enforce the restriction in the current render, before the persistence effect runs.
    hidden: callActive || hidden,
    toggle,
    showNotice: callActive && noticeVisible,
  };
}

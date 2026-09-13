import { getTerminalRuntime } from "../terminal-runtime";
import type { SessionTabManager } from "./session-tab-manager";

/** Call tabs and stale IDs must never create a terminal runtime as a side effect. */
export function getWorkTerminalRuntime(manager: SessionTabManager, sessionId: string) {
  if (manager.isCallSession(sessionId) || !manager.getState().sessions.includes(sessionId))
    return null;
  return getTerminalRuntime(sessionId);
}

/** Read the current tab at keydown time, including before React has rerendered. */
export function installCommandRunKeybindings(manager: SessionTabManager): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (
      !(event.code === "KeyF" && event.shiftKey) &&
      event.code !== "BracketRight" &&
      event.code !== "BracketLeft"
    )
      return;
    event.preventDefault();
    const terminal = getWorkTerminalRuntime(manager, manager.getState().activeSessionId);
    if (!terminal) return;
    if (event.code === "KeyF") terminal.attachLastFailedRun();
    else if (event.code === "BracketRight")
      terminal.scrollToAdjacentCommandRun("next", { failedOnly: event.shiftKey });
    else terminal.scrollToAdjacentCommandRun("previous");
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}

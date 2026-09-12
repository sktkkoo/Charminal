/** Transient controls yield to the next toolbar action without stopping their underlying session. */
export type ControlSurface = "call" | "settings" | "sharing" | "view-mode" | "sidebar" | "voice";

const EVENT = "yorishiro-control-surface";

export function requestControlSurface(surface: ControlSurface): void {
  window.dispatchEvent(new CustomEvent<ControlSurface>(EVENT, { detail: surface }));
}

export function subscribeControlSurface(callback: (surface: ControlSurface) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<ControlSurface>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

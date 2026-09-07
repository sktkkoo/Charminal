import type { ReactNode } from "react";

/** Debug controls own their gestures, including Leva popovers portaled to body. */
export function DebugControlsBoundary({ children }: { readonly children: ReactNode }) {
  return (
    <div
      data-no-window-drag=""
      style={{ display: "contents" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

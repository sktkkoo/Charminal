// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DebugControlsBoundary } from "./debug-controls-boundary";
import { shouldStartViewModeWindowDrag } from "./runtime/view-mode-window-interaction";

afterEach(cleanup);

it("isolates inline and portaled debug gestures while keeping blank-area window drag", () => {
  const startDragging = vi.fn();
  const debugGesture = vi.fn();
  const { getByTestId } = render(
    <div
      onPointerDown={(event) => {
        if (!shouldStartViewModeWindowDrag(true, event.button, event.target)) return;
        event.preventDefault();
        startDragging();
      }}
    >
      <DebugControlsBoundary>
        <div data-testid="panel-title" onPointerDown={debugGesture} />
        {createPortal(
          <div data-testid="color-picker" onPointerDown={debugGesture} />,
          document.body,
        )}
      </DebugControlsBoundary>
      <canvas data-testid="scene" />
    </div>,
  );

  for (const id of ["panel-title", "color-picker"]) {
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    fireEvent(getByTestId(id), event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(debugGesture).toHaveBeenCalledTimes(2);
  expect(startDragging).not.toHaveBeenCalled();

  fireEvent(
    getByTestId("scene"),
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
  );
  expect(startDragging).toHaveBeenCalledOnce();
});

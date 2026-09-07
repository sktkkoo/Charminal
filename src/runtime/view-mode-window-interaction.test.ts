// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  nextViewModeHudVisibility,
  shouldRevealViewModeHud,
  shouldStartViewModeWindowDrag,
} from "./view-mode-window-interaction";

describe("chrome-hidden View Mode window interaction", () => {
  it("starts primary drag only in chrome-hidden modes", () => {
    const canvas = document.createElement("canvas");
    expect(shouldStartViewModeWindowDrag(true, 0, canvas)).toBe(true);
    expect(shouldStartViewModeWindowDrag(false, 0, canvas)).toBe(false);
    expect(shouldStartViewModeWindowDrag(true, 2, canvas)).toBe(false);
  });

  it("excludes interactive descendants", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    expect(shouldStartViewModeWindowDrag(true, 0, icon)).toBe(false);
  });

  it("leaves debug panel drags and slider gestures inside their no-window-drag boundary", () => {
    const root = document.createElement("div");
    const debugPanels = document.createElement("div");
    debugPanels.setAttribute("data-no-window-drag", "");
    debugPanels.style.display = "contents";
    const titleBar = document.createElement("div");
    const sliderRail = document.createElement("div");
    const sliderThumb = document.createElement("span");
    sliderRail.append(sliderThumb);
    debugPanels.append(titleBar, sliderRail);
    const canvas = document.createElement("canvas");
    root.append(debugPanels, canvas);
    let windowDrags = 0;
    let debugGestures = 0;
    root.addEventListener("pointerdown", (event) => {
      if (shouldStartViewModeWindowDrag(true, (event as MouseEvent).button, event.target)) {
        event.preventDefault();
        windowDrags++;
      }
    });
    debugPanels.addEventListener("pointerdown", () => debugGestures++);

    for (const target of [titleBar, sliderRail, sliderThumb]) {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(debugGestures).toBe(3);
    expect(windowDrags).toBe(0);

    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(windowDrags).toBe(1);
  });

  it("uses secondary click to reveal the HUD", () => {
    expect(shouldRevealViewModeHud(true, 2)).toBe(true);
    expect(shouldRevealViewModeHud(true, 0)).toBe(false);
    expect(shouldRevealViewModeHud(false, 2)).toBe(false);
  });

  it("toggles the HUD off on a second secondary click", () => {
    const shown = nextViewModeHudVisibility(true, 2, false);
    expect(shown).toBe(true);
    expect(nextViewModeHudVisibility(true, 2, shown)).toBe(false);
  });

  it("lets a root capture handler see secondary click before a child stops bubbling", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("canvas");
    root.append(canvas);
    let revealed = false;
    root.addEventListener(
      "contextmenu",
      (event) => {
        revealed = shouldRevealViewModeHud(true, event.button);
      },
      { capture: true },
    );
    canvas.addEventListener("contextmenu", (event) => event.stopPropagation());

    canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));

    expect(revealed).toBe(true);
  });
});

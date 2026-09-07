// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupErrorBoundary } from "./components/StartupErrorBoundary";
import { startApplication } from "./startup-error";

afterEach(() => {
  cleanup();
  document.getElementById("startup-error")?.remove();
  vi.restoreAllMocks();
});

describe("startup recovery", () => {
  it("shows import failures without React or application styles", async () => {
    await startApplication(() => Promise.reject(new Error("Missing export <App>")));
    const panel = document.getElementById("startup-error");
    expect(panel?.textContent).toContain("Missing export <App>");
    expect(panel?.querySelector("app")).toBeNull();
    expect(panel?.querySelector("button")?.textContent).toBe("Reload");
    expect(document.activeElement).toBe(panel?.querySelector("button"));
    expect(panel?.querySelector("details")?.open).toBe(false);
  });

  it("does not show recovery when startup succeeds", async () => {
    await startApplication(() => Promise.resolve());
    expect(document.getElementById("startup-error")).toBeNull();
  });

  it("catches lazy application import rejection outside Suspense", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Application = lazy(() => Promise.reject(new Error("Cannot import App")));
    await act(async () => {
      render(
        <StartupErrorBoundary>
          <Suspense fallback={null}>
            <Application />
          </Suspense>
        </StartupErrorBoundary>,
      );
    });
    expect(document.getElementById("startup-error")?.textContent).toContain("Cannot import App");
  });

  it("catches render errors even when the richer recovery boundary cannot render", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new Error("Render failed");
    }
    render(
      <StartupErrorBoundary>
        <Broken />
      </StartupErrorBoundary>,
    );
    expect(document.getElementById("startup-error")?.textContent).toContain("Render failed");
  });
});

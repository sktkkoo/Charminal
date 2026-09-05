// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenSharingControl, type ScreenSharingControlProps } from "./screen-sharing-control";

afterEach(cleanup);
function props(): ScreenSharingControlProps {
  return {
    available: true,
    active: false,
    busy: false,
    intervalSeconds: 30,
    sources: [{ id: 1, name: "Display 1" }],
    sourceId: 1,
    onIntervalChange: vi.fn(),
    onSourceChange: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onClearAnnotations: vi.fn(),
    onRefreshSources: vi.fn(),
    language: "ja",
  };
}
describe("screen sharing control", () => {
  it("shows the token warning before explicit start and supports a five-second interval", () => {
    const p = props();
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect(screen.getByText(/トークンを多く消費/)).toBeTruthy();
    expect(p.onStart).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "5" } });
    expect(p.onIntervalChange).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole("button", { name: "共有を開始" }));
    expect(p.onStart).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("allows cancelling pending permission and keeps the panel inside a narrow window", () => {
    vi.stubGlobal("innerWidth", 240);
    const p = { ...props(), busy: true };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    const panel = screen.getByRole("dialog");
    expect(panel.style.left).toBe("12px");
    expect(panel.style.width).toBe("216px");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(p.onStop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("clears markers while sharing continues and can open separate controls", () => {
    const p = { ...props(), active: true, busy: true, onOpenAuxiliary: vi.fn() };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有中" }));
    fireEvent.click(screen.getByRole("button", { name: "画面の目印を消す" }));
    expect(p.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(p.onStop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "画面共有を別ウィンドウで開く" }));
    expect(p.onOpenAuxiliary).toHaveBeenCalledTimes(1);
  });
});

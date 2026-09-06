// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenSharingControl, type ScreenSharingControlProps } from "./screen-sharing-control";

afterEach(cleanup);
function props(): ScreenSharingControlProps {
  return {
    available: true,
    active: false,
    busy: false,
    pointersEnabled: true,
    pointersReady: true,
    intervalSeconds: 30,
    sources: [{ id: 1, name: "Display 1" }],
    sourceId: 1,
    onIntervalChange: vi.fn(),
    onSourceChange: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onClearAnnotations: vi.fn(),
    onPointersEnabledChange: vi.fn(),
    onRetryPointers: vi.fn(),
    onRefreshSources: vi.fn(),
    language: "ja",
  };
}
describe("screen sharing control", () => {
  it("offers retry after initial marker synchronization fails and prevents early sharing", () => {
    const p = { ...props(), pointersReady: false, error: "Could not update marker setting" };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect((screen.getByRole("button", { name: "共有を開始" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "指し示し設定を再試行" }));
    expect(p.onRetryPointers).toHaveBeenCalledOnce();
  });

  it("shows the token warning before explicit start and supports a five-second interval", () => {
    const p = props();
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect(screen.getByText("画像の定期送信ではトークンを多く消費します。")).toBeTruthy();
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

  it("closes only the popover after separate controls open without stopping sharing", async () => {
    const p = {
      ...props(),
      active: true,
      busy: true,
      onOpenAuxiliary: vi.fn().mockResolvedValue(undefined),
    };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有中" }));
    fireEvent.click(screen.getByRole("button", { name: "指し示しを消す" }));
    expect(p.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(p.onStop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "画面共有を別ウィンドウで開く" }));
    expect(p.onOpenAuxiliary).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "画面共有中" })).toBeTruthy();
    expect(p.onStop).not.toHaveBeenCalled();
  });

  it("waits for a single open request even when the popout button is clicked repeatedly", async () => {
    let finish!: () => void;
    const onOpenAuxiliary = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ScreenSharingControl {...props()} onOpenAuxiliary={onOpenAuxiliary} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    const popout = screen.getByRole("button", {
      name: "画面共有を別ウィンドウで開く",
    }) as HTMLButtonElement;
    fireEvent.click(popout);
    fireEvent.click(popout);
    fireEvent.click(popout);
    expect(onOpenAuxiliary).toHaveBeenCalledOnce();
    expect(popout.disabled).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: "エージェントの指し示し" }) as HTMLInputElement).disabled,
    ).toBe(false);
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps failed popouts open with an error and allows regular controls and another attempt", async () => {
    const p = {
      ...props(),
      onOpenAuxiliary: vi
        .fn()
        .mockRejectedValueOnce(new Error("Unable to open controls"))
        .mockResolvedValueOnce(undefined),
    };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    fireEvent.click(screen.getByRole("button", { name: "画面共有を別ウィンドウで開く" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unable to open controls");
    expect(screen.getByRole("dialog")).toBeTruthy();
    const popout = screen.getByRole("button", {
      name: "画面共有を別ウィンドウで開く",
    }) as HTMLButtonElement;
    expect(popout.disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "エージェントの指し示し" }));
    expect(p.onPointersEnabledChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "共有を開始" }));
    expect(p.onStart).toHaveBeenCalledOnce();
    fireEvent.click(popout);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(p.onOpenAuxiliary).toHaveBeenCalledTimes(2);
  });

  it("keeps marker OFF available during image delivery without stopping sharing", () => {
    const p = { ...props(), active: true, busy: true };
    const view = render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有中" }));
    fireEvent.click(screen.getByRole("switch", { name: "エージェントの指し示し" }));
    expect(p.onPointersEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(p.onStop).not.toHaveBeenCalled();
    view.rerender(<ScreenSharingControl {...p} pointersEnabled={false} pointersReady={false} />);
    const toggle = screen.getByRole("switch", {
      name: "エージェントの指し示し",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
  });
});

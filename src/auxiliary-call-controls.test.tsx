// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedCallControls } from "./runtime/peer-call/call-controls-window";

const test = vi.hoisted(() => ({
  receive: null as ((value: PublishedCallControls) => void) | null,
  read: vi.fn(),
  request: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("./runtime/peer-call/call-controls-window", () => ({
  listenCallControls: async (callback: (value: PublishedCallControls) => void) => {
    test.receive = callback;
    return test.unlisten;
  },
  readCallControls: () => test.read(),
  requestCallControls: (version: number, action: unknown) => test.request(version, action),
}));

import AuxiliaryCallControls from "./auxiliary-call-controls";

const state = (version = 1): PublishedCallControls => ({
  version,
  snapshot: {
    revision: `revision-${version}`,
    ownerKey: "owner",
    enabled: true,
    language: "ja",
    name: "より",
    localName: "より",
    remoteName: "GPT",
    active: false,
    connected: false,
    busy: null,
    status: "招待するか招待コードで参加してください",
    error: "",
    notice: "",
    endpoint: "ws://localhost:1531/rooms",
    signalState: "idle",
    role: "",
    invitation: "",
    guest: null,
  },
});
beforeEach(() => {
  test.read.mockResolvedValue(state());
  test.request.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("detached call entry presentation", () => {
  it("shows the existing disclosure and submits edited identity with the current published version", async () => {
    render(<AuxiliaryCallControls />);
    await screen.findByText("通話を始める");
    expect(screen.getByText(/参加すると、名前・アバター・通話の音声/)).toBeTruthy();
    expect(test.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "通話での名前" }), {
      target: { value: "Mafu" },
    });
    const next = state(2);
    act(() => test.receive?.(next));
    expect(screen.getByRole("textbox", { name: "通話での名前" })).toHaveProperty("value", "Mafu");
    fireEvent.click(screen.getByRole("button", { name: "部屋を作る" }));
    await waitFor(() =>
      expect(test.request).toHaveBeenCalledWith(2, { type: "create", name: "Mafu" }),
    );
  });

  it("keeps the newer event when the initial native read finishes late", async () => {
    let resolve!: (value: PublishedCallControls) => void;
    test.read.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<AuxiliaryCallControls />);
    await waitFor(() => expect(test.read).toHaveBeenCalled());
    const newer = state(3);
    newer.snapshot.status = "最新の受付状態";
    act(() => test.receive?.(newer));
    await act(async () => resolve(state(1)));
    expect(screen.getByText("最新の受付状態")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "通話画面を閉じる" }));
    await waitFor(() => expect(test.request).toHaveBeenCalledWith(3, { type: "hide" }));
  });

  it("answers only the displayed guest and surfaces a stale action error", async () => {
    const pending = state(4);
    Object.assign(pending.snapshot, {
      active: true,
      signalState: "pending",
      guest: { name: "GPT", requestId: "current-request" },
    });
    test.read.mockResolvedValue(pending);
    test.request.mockRejectedValueOnce(new Error("Call state changed"));
    render(<AuxiliaryCallControls />);
    await screen.findByRole("button", { name: "通話に出る" });
    fireEvent.click(screen.getByRole("button", { name: "通話に出る" }));
    await waitFor(() =>
      expect(test.request).toHaveBeenCalledWith(4, {
        type: "accept",
        requestId: "current-request",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Call state changed");
  });

  it("reports a hide failure inside the published view and never submits a cancel on close", async () => {
    test.request.mockRejectedValueOnce(new Error("Hide temporarily unavailable"));
    render(<AuxiliaryCallControls />);
    await screen.findByText("通話を始める");
    fireEvent.click(screen.getByRole("button", { name: "通話画面を閉じる" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Hide temporarily unavailable",
    );
    expect(test.request).toHaveBeenCalledExactlyOnceWith(1, { type: "hide" });
  });
});

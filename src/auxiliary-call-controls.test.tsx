// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it.each([
    "ja",
    "en",
  ] as const)("distinguishes terminal identity failure from network retry in %s", async (language) => {
    const failed = state();
    Object.assign(failed.snapshot, {
      language,
      endpoint: "wss://call.example.test/v2/rooms",
      presenceState: "error",
      presenceError: "通話の識別情報を準備できませんでした。アプリを再起動してお試しください。",
    });
    test.read.mockResolvedValue(failed);
    render(<AuxiliaryCallControls />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      language === "ja"
        ? failed.snapshot.presenceError
        : "Could not prepare your call identity. Restart the app and try again.",
    );
    const offline = {
      ...failed,
      version: 2,
      snapshot: { ...failed.snapshot, revision: "revision-2", presenceState: "offline" as const },
    };
    act(() => test.receive?.(offline));
    expect(screen.queryByRole("alert")).toBeNull();
    const contacts = screen.getByRole("region", {
      name: language === "ja" ? "通話した相手" : "Contacts",
    });
    expect(within(contacts).getByRole("status").textContent).toBe(
      language === "ja"
        ? "通話の待受に接続できません。接続をやり直しています。"
        : "Cannot connect to receive calls. Reconnecting…",
    );
  });

  it.each([
    undefined,
    "unknown internal diagnostic",
  ])("uses a terminal fallback for an omitted or unknown presence failure (%s)", async (presenceError) => {
    const failed = state();
    Object.assign(failed.snapshot, {
      language: "en",
      endpoint: "wss://call.example.test/v2/rooms",
      presenceState: "error",
      presenceError,
    });
    test.read.mockResolvedValue(failed);
    render(<AuxiliaryCallControls />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not connect to receive calls. Restart the app and try again.",
    );
    expect(screen.queryByText("unknown internal diagnostic")).toBeNull();
  });

  it.each([
    "ja",
    "en",
  ] as const)("explains invite-only calling in %s and lets the user review the unchanged connection", async (language) => {
    const legacy = state();
    legacy.snapshot.language = language;
    test.read.mockResolvedValue(legacy);
    render(<AuxiliaryCallControls />);
    const notice = await screen.findByRole("note");
    expect(notice.textContent).toContain(
      language === "ja" ? "再発信用に保存されず" : "not saved for redial",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: language === "ja" ? "接続先を確認" : "Check connection",
      }),
    );
    const endpoint = screen.getByRole("textbox", {
      name: language === "ja" ? "通話サーバー" : "Call server",
    });
    expect(endpoint).toHaveProperty("value", legacy.snapshot.endpoint);
    expect(endpoint.getAttribute("placeholder")).toBe("wss://example.com/v2/rooms");
    expect(test.request).not.toHaveBeenCalled();
    const managedEndpoint = "wss://custom.example.test/v2/rooms";
    fireEvent.change(endpoint, { target: { value: managedEndpoint } });
    fireEvent.click(screen.getByRole("button", { name: language === "ja" ? "保存する" : "Save" }));
    await waitFor(() =>
      expect(test.request).toHaveBeenCalledExactlyOnceWith(1, {
        type: "save-endpoint",
        endpoint: managedEndpoint,
      }),
    );
    const managed = state(2);
    managed.snapshot.language = language;
    managed.snapshot.endpoint = managedEndpoint;
    managed.snapshot.presenceState = "online";
    act(() => test.receive?.(managed));
    expect(screen.queryByRole("note")).toBeNull();
    expect(
      screen.getByRole("heading", { name: language === "ja" ? "通話した相手" : "Contacts" }),
    ).toBeTruthy();
  });

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
    fireEvent.click(screen.getByRole("button", { name: "新しい相手を招待" }));
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

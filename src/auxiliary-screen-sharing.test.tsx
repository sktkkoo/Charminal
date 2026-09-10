// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuxiliaryScreenSharing from "./auxiliary-screen-sharing";
import {
  listenAuxiliarySnapshot,
  type PublishedAuxiliarySnapshot,
  readAuxiliarySnapshot,
  requestAuxiliaryAction,
} from "./runtime/auxiliary-windows";

vi.mock("./runtime/auxiliary-windows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime/auxiliary-windows")>()),
  listenAuxiliarySnapshot: vi.fn(),
  readAuxiliarySnapshot: vi.fn(),
  requestAuxiliaryAction: vi.fn(),
}));

const unlisten = vi.fn();
let receive: (state: PublishedAuxiliarySnapshot) => void = () => {};
let state: PublishedAuxiliarySnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    version: 1,
    snapshot: {
      revision: "main-revision",
      pointerRevision: "pointer-revision",
      available: true,
      active: false,
      busy: false,
      pointersEnabled: true,
      pointersReady: true,
      sources: [
        { id: 1, name: "Display 1" },
        { id: 2, name: "Display 2" },
      ],
      sourceId: 1,
      intervalSeconds: 30,
      hasError: false,
      lastObservedAt: null,
      language: "en",
    },
  };
  vi.mocked(listenAuxiliarySnapshot).mockImplementation(async (callback) => {
    receive = callback;
    return unlisten;
  });
  vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
  vi.mocked(requestAuxiliaryAction).mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("independent screen-sharing controls", () => {
  it("requests camera preview visibility while sharing remains active", async () => {
    state = {
      ...state,
      snapshot: { ...state.snapshot, sourceKind: "camera", active: true, busy: true },
    };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Preview",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledExactlyOnceWith(state.version, {
        type: "set-preview-visible",
        visible: false,
      }),
    );
    act(() =>
      receive({
        ...state,
        version: state.version + 1,
        snapshot: { ...state.snapshot, previewVisible: false },
      }),
    );
    expect(toggle.checked).toBe(false);
  });
  it("shows source-selection failures while keeping the sharing menu available", async () => {
    state = { ...state, snapshot: { ...state.snapshot, sourceKind: "screen" } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    vi.mocked(requestAuxiliaryAction).mockRejectedValueOnce(new Error("Snapshot changed"));
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Share camera" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Snapshot changed");
    expect(screen.queryByRole("button", { name: "Start sharing" })).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Share camera" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("selects camera through the shared menu and starts independently of screen pointers", async () => {
    state = { ...state, snapshot: { ...state.snapshot, sourceKind: "screen" } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    await screen.findByRole("button", { name: "Share camera" });
    fireEvent.click(screen.getByRole("button", { name: "Share camera" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, {
        type: "select-source-kind",
        sourceKind: "camera",
      }),
    );
    await act(async () =>
      receive({
        version: 2,
        snapshot: {
          ...state.snapshot,
          sourceKind: "camera",
          pointersReady: false,
          sources: [{ id: 9, name: "USB camera" }],
          sourceId: 9,
        },
      }),
    );
    expect(screen.getByLabelText("Camera")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Agent pointing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    await waitFor(() => expect(requestAuxiliaryAction).toHaveBeenCalledWith(2, { type: "start" }));
  });

  it("sends rapid OFF and ON intents before a publication and restores published state on rejection", async () => {
    let rejectLatest!: (error: Error) => void;
    vi.mocked(requestAuxiliaryAction)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectLatest = reject;
        }),
      );
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Agent pointing",
    })) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(requestAuxiliaryAction).toHaveBeenNthCalledWith(
      1,
      1,
      { type: "set-pointers-enabled", enabled: false },
      "pointer-revision",
    );
    expect(requestAuxiliaryAction).toHaveBeenNthCalledWith(
      2,
      1,
      { type: "set-pointers-enabled", enabled: true },
      "pointer-revision",
    );
    const refreshed = { version: 2, snapshot: { ...state.snapshot, pointersEnabled: false } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(refreshed);
    await act(async () => rejectLatest(new Error("Snapshot changed")));
    expect(toggle.checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Snapshot changed");
    expect(requestAuxiliaryAction).toHaveBeenCalledTimes(2);
  });

  it("requests recovery when initial marker synchronization failed", async () => {
    state = { ...state, snapshot: { ...state.snapshot, pointersReady: false, hasError: true } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry pointing setup" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(
        1,
        { type: "retry-pointers" },
        "pointer-revision",
      ),
    );
  });

  it("uses the main owner's state for start, stop, and another start", async () => {
    render(<AuxiliaryScreenSharing />);
    const start = await screen.findByRole("button", { name: "Start sharing" });
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.click(start);
    await waitFor(() => expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, { type: "start" }));
    state = { version: 2, snapshot: { ...state.snapshot, active: true } };
    await act(async () => receive(state));
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(2, { type: "stop" }),
    );
    state = { version: 3, snapshot: { ...state.snapshot, active: false } };
    await act(async () => receive(state));
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(3, { type: "start" }),
    );
  });

  it("keeps keyboard focus during passive updates and commits a dragged interval once", async () => {
    render(<AuxiliaryScreenSharing />);
    const interval = (await screen.findByRole("slider", {
      name: "Update interval",
    })) as HTMLInputElement;
    expect(interval.min).toBe("20");
    expect(interval.max).toBe("60");
    expect(interval.value).toBe("30");
    interval.focus();
    state = {
      version: 2,
      snapshot: { ...state.snapshot, active: true, lastObservedAt: Date.now() },
    };
    await act(async () => receive(state));
    expect(document.activeElement).toBe(interval);
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.change(interval, { target: { value: "25" } });
    fireEvent.change(interval, { target: { value: "20" } });
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.pointerUp(interval);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledExactlyOnceWith(2, {
        type: "set-interval",
        intervalSeconds: 20,
      }),
    );
  });

  it("selects and refreshes a stopped source, and disposes only its state listener when closed", async () => {
    const view = render(<AuxiliaryScreenSharing />);
    const select = await screen.findByRole("combobox", { name: "Display" });
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, {
        type: "select-source",
        sourceId: 2,
      }),
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Refresh displays" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(1, { type: "refresh-sources" }),
    );
    const callsBeforeClose = vi.mocked(requestAuxiliaryAction).mock.calls.length;
    view.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(requestAuxiliaryAction).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it("can disable markers while capture and another control request are pending", async () => {
    state = { ...state, snapshot: { ...state.snapshot, active: true, busy: true } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    vi.mocked(requestAuxiliaryAction).mockReturnValueOnce(new Promise(() => {}));
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Agent pointing",
    })) as HTMLInputElement;
    const interval = screen.getByRole("slider", { name: "Update interval" });
    fireEvent.change(interval, { target: { value: "20" } });
    fireEvent.pointerUp(interval);
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(
        1,
        { type: "set-pointers-enabled", enabled: false },
        "pointer-revision",
      ),
    );
    state = { version: 2, snapshot: { ...state.snapshot, pointersEnabled: false } };
    await act(async () => receive(state));
    expect(toggle.checked).toBe(false);
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
  });

  it("keeps pending OFF through capture updates and discards it when the pointer owner changes", async () => {
    vi.mocked(requestAuxiliaryAction).mockReturnValueOnce(new Promise(() => {}));
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Agent pointing",
    })) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    state = {
      version: 2,
      snapshot: { ...state.snapshot, revision: "capture-revision", lastObservedAt: 1234 },
    };
    await act(async () => receive(state));
    expect(toggle.checked).toBe(false);
    expect(requestAuxiliaryAction).toHaveBeenCalledExactlyOnceWith(
      1,
      { type: "set-pointers-enabled", enabled: false },
      "pointer-revision",
    );
    state = {
      version: 3,
      snapshot: { ...state.snapshot, pointerRevision: "replacement-pointer-owner" },
    };
    await act(async () => receive(state));
    expect(toggle.checked).toBe(true);
  });
});

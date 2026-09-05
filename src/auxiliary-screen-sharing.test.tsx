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
      available: true,
      active: false,
      busy: false,
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
  it("uses the main owner's state for start, clear, stop, and another start", async () => {
    render(<AuxiliaryScreenSharing />);
    const start = await screen.findByRole("button", { name: "Start sharing" });
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.click(start);
    await waitFor(() => expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, { type: "start" }));
    state = { version: 2, snapshot: { ...state.snapshot, active: true } };
    await act(async () => receive(state));
    fireEvent.click(screen.getByRole("button", { name: "Clear screen markers" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(2, { type: "clear-annotations" }),
    );
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
    const interval = await screen.findByRole("slider", { name: "Viewing interval" });
    interval.focus();
    state = {
      version: 2,
      snapshot: { ...state.snapshot, active: true, lastObservedAt: Date.now() },
    };
    await act(async () => receive(state));
    expect(document.activeElement).toBe(interval);
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.change(interval, { target: { value: "15" } });
    fireEvent.change(interval, { target: { value: "5" } });
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.pointerUp(interval);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledExactlyOnceWith(2, {
        type: "set-interval",
        intervalSeconds: 5,
      }),
    );
  });

  it("selects and refreshes a stopped source, and disposes only its state listener when closed", async () => {
    const view = render(<AuxiliaryScreenSharing />);
    const select = await screen.findByRole("combobox", { name: "Shared display" });
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
});

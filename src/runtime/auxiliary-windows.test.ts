import { describe, expect, it, vi } from "vitest";
import {
  AUXILIARY_CONTROLS_LABEL,
  createScreenSharingSnapshot,
  latestAuxiliarySnapshot,
  type RoutedAuxiliaryAction,
  resolveWindowView,
  ScreenSharingAuxiliaryHost,
  type ScreenSharingAuxiliaryModel,
  type ScreenSharingSnapshot,
} from "./auxiliary-windows";

function model(): ScreenSharingAuxiliaryModel {
  return {
    ownerKey: "private-session-and-thread",
    available: true,
    active: false,
    busy: false,
    sources: [
      { id: 1, name: "Display 1" },
      { id: 2, name: "Display 2" },
    ],
    sourceId: 1,
    intervalSeconds: 30,
    language: "ja-JP",
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    refreshSources: vi.fn(async () => {}),
    clearAnnotations: vi.fn(async () => {}),
    setSourceId: vi.fn(),
    setIntervalSeconds: vi.fn(),
  };
}

function transport() {
  let revision = 0;
  const unlisten = vi.fn();
  return {
    listenAction: vi.fn(
      async (_callback: (request: RoutedAuxiliaryAction) => void): Promise<() => void> => unlisten,
    ),
    publish: vi.fn(async (_snapshot: ScreenSharingSnapshot) => {}),
    open: vi.fn(async () => {}),
    revision: () => `revision-${++revision}`,
    unlisten,
  };
}

describe("auxiliary window ownership", () => {
  it("requires the allowlisted native label and route before mounting controls", () => {
    expect(resolveWindowView("main", "")).toBe("main");
    expect(resolveWindowView("main", "?auxiliary=screen-sharing-controls")).toBe("main");
    expect(resolveWindowView(AUXILIARY_CONTROLS_LABEL, "?auxiliary=screen-sharing-controls")).toBe(
      "screen-sharing-controls",
    );
    expect(resolveWindowView(AUXILIARY_CONTROLS_LABEL, "")).toBeNull();
    expect(resolveWindowView("untrusted", "?auxiliary=screen-sharing-controls")).toBeNull();
  });

  it("copies only safe display fields and redacts provider errors and owner identity", () => {
    const snapshot = createScreenSharingSnapshot(
      {
        ...model(),
        error: "Provider failed with private credential abc",
        sources: [
          { id: 1, name: "Display 1", imageDataUrl: "secret image" } as {
            id: number;
            name: string;
          },
        ],
      },
      "revision",
    );
    expect(snapshot.sources).toEqual([{ id: 1, name: "Display 1" }]);
    expect(snapshot.hasError).toBe(true);
    expect(snapshot.language).toBe("ja");
    expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|credential|ownerKey|imageDataUrl/);
  });

  it("opens explicitly after publishing, then updates stop state without opening or focusing again", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = { ...model(), active: true };
    host.update(current);
    await host.open();
    expect(port.publish).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    expect(port.open).toHaveBeenCalledTimes(1);
    host.update({ ...current, active: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.publish).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    expect(port.open).toHaveBeenCalledTimes(1);
    expect(current.start).not.toHaveBeenCalled();
    host.dispose();
    expect(port.unlisten).toHaveBeenCalledOnce();
  });

  it("rejects stale actions immediately on owner replacement, even before native publication", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const original = model();
    host.update(original);
    const replacement = { ...model(), ownerKey: "replacement" };
    host.update(replacement);
    expect(await host.handleAction({ revision: "revision-1", action: { type: "start" } })).toBe(
      false,
    );
    expect(await host.handleAction({ revision: "revision-1", action: { type: "stop" } })).toBe(
      false,
    );
    expect(original.start).not.toHaveBeenCalled();
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(await host.handleAction({ revision: "revision-2", action: { type: "start" } })).toBe(
      true,
    );
    expect(replacement.start).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("routes clear, source, and interval operations to the current hook and protects busy capture", async () => {
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), transport());
    const current = model();
    host.update(current);
    const action = (value: RoutedAuxiliaryAction["action"]) =>
      host.handleAction({ revision: "revision-1", action: value });
    expect(await action({ type: "select-source", sourceId: 99 })).toBe(false);
    expect(await action({ type: "select-source", sourceId: 2 })).toBe(true);
    expect(current.setSourceId).toHaveBeenCalledWith(2);
    expect(await action({ type: "set-interval", intervalSeconds: 4 })).toBe(false);
    expect(await action({ type: "set-interval", intervalSeconds: 5 })).toBe(true);
    expect(current.setIntervalSeconds).toHaveBeenCalledWith(5);
    expect(await action({ type: "clear-annotations" })).toBe(true);
    expect(current.clearAnnotations).toHaveBeenCalledOnce();
    expect(current.stop).not.toHaveBeenCalled();
    host.update({ ...current, active: true, busy: true });
    expect(
      await host.handleAction({
        revision: "revision-2",
        action: { type: "select-source", sourceId: 2 },
      }),
    ).toBe(false);
    expect(
      await host.handleAction({ revision: "revision-2", action: { type: "refresh-sources" } }),
    ).toBe(false);
    expect(await host.handleAction({ revision: "revision-2", action: { type: "stop" } })).toBe(
      true,
    );
    expect(current.stop).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("serializes state publications and cancels queued work when the owner unmounts", async () => {
    const port = transport();
    let finishFirst: () => void = () => {};
    port.publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = model();
    host.update(current);
    await Promise.resolve();
    host.update({ ...current, active: true });
    expect(port.publish).toHaveBeenCalledTimes(1);
    host.dispose();
    finishFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(port.publish).toHaveBeenCalledTimes(1);
    expect(await host.handleAction({ revision: "revision-2", action: { type: "start" } })).toBe(
      false,
    );
  });

  it("releases subscriptions that finish after an unmount", async () => {
    const port = transport();
    let completeListen: (cleanup: () => void) => void = () => {};
    port.listenAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeListen = resolve;
        }),
    );
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    host.dispose();
    completeListen(port.unlisten);
    await Promise.resolve();
    expect(port.unlisten).toHaveBeenCalledOnce();
    expect(port.publish).not.toHaveBeenCalled();
  });

  it("keeps newer state if an initial read arrives after a sharing-stop event", () => {
    const current = { version: 3, snapshot: createScreenSharingSnapshot(model(), "current") };
    const stale = { version: 2, snapshot: { ...current.snapshot, active: true } };
    expect(latestAuxiliarySnapshot(current, stale)).toBe(current);
    expect(latestAuxiliarySnapshot(null, current)).toBe(current);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  CallControlsHost,
  type CallControlsPort,
  type CallEntrySnapshot,
  callControlsActionAllowed,
  type PublishedCallControls,
  type RoutedCallControlsAction,
} from "./call-controls-window";

const entry = (patch: Partial<CallEntrySnapshot> = {}): CallEntrySnapshot => ({
  ownerKey: "room-one",
  enabled: true,
  language: "ja",
  name: "より",
  localName: "より",
  remoteName: "GPT",
  active: false,
  connected: false,
  busy: null,
  status: "Start",
  error: "",
  notice: "",
  endpoint: "ws://localhost:1531/rooms",
  signalState: "idle",
  role: "",
  invitation: "",
  guest: null,
  ...patch,
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const log: string[] = [];
  const published: PublishedCallControls["snapshot"][] = [];
  const callbacks: ((event: RoutedCallControlsAction) => void)[] = [];
  const closed: (() => void)[] = [];
  const unlisten = [vi.fn(), vi.fn()];
  const port: CallControlsPort = {
    publish: vi.fn(async (snapshot) => {
      published.push(snapshot);
      log.push(`publish:${snapshot.ownerKey}`);
    }),
    open: vi.fn(async () => {
      log.push("open");
    }),
    hide: vi.fn(async () => {
      log.push("hide");
    }),
    listen: vi.fn(async (callback) => {
      callbacks.push(callback);
      return unlisten[0];
    }),
    listenClosed: vi.fn(async (callback) => {
      closed.push(callback);
      return unlisten[1];
    }),
  };
  return { port, log, published, callbacks, closed, unlisten };
}

describe("host-owned call entry window", () => {
  it("publishes before explicit opening and never opens on a waiting-room update", async () => {
    const test = setup(),
      action = vi.fn(),
      onClosed = vi.fn();
    const host = new CallControlsHost(vi.fn(), onClosed, test.port);
    host.update(entry({ enabled: false }), action);
    await flush();
    expect(test.port.publish).not.toHaveBeenCalled();
    host.update(entry(), action);
    host.setVisible(true);
    await flush();
    expect(test.log).toEqual(["publish:room-one", "publish:room-one", "open"]);
    host.update(entry({ active: true, signalState: "hosting" }), action);
    await flush();
    expect(test.port.open).toHaveBeenCalledOnce();
    host.setVisible(false);
    await flush();
    expect(test.port.hide).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    host.setVisible(true);
    await flush();
    test.closed[0]();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    host.dispose();
    await flush();
  });

  it("rejects stale snapshots and duplicate intents, forwarding the original owner fence", async () => {
    const test = setup(),
      action = vi.fn();
    const host = new CallControlsHost(vi.fn(), vi.fn(), test.port);
    host.update(entry(), action);
    await flush();
    const old = test.published[test.published.length - 1];
    const event = { revision: old.revision, action: { type: "create" as const, name: "より" } };
    test.callbacks[0](event);
    test.callbacks[0](event);
    expect(action).toHaveBeenCalledExactlyOnceWith(event.action, "room-one");
    host.update(entry({ ownerKey: "room-two" }), action);
    await flush();
    test.callbacks[0](event);
    expect(action).toHaveBeenCalledOnce();
    host.update(entry({ ownerKey: "room-two", enabled: false }), action);
    await flush();
    test.callbacks[0]({
      revision: test.published[test.published.length - 1].revision,
      action: { type: "cancel" },
    });
    expect(action).toHaveBeenCalledOnce();
    host.dispose();
    await flush();
  });

  it("does not resurrect a surface when hiding during its initial publication", async () => {
    const test = setup(),
      pending = deferred();
    vi.mocked(test.port.publish).mockImplementationOnce(() => pending.promise);
    const host = new CallControlsHost(vi.fn(), vi.fn(), test.port);
    host.update(entry(), vi.fn());
    host.setVisible(true);
    await flush();
    host.update(entry({ enabled: false }), vi.fn());
    host.setVisible(false);
    pending.resolve();
    await flush();
    expect(test.port.open).not.toHaveBeenCalled();
    expect(test.port.hide).toHaveBeenCalledOnce();
    host.dispose();
    await flush();
  });

  it("fences replacement hosts across an already running old native open", async () => {
    const test = setup(),
      pending = deferred(),
      oldSuccess = vi.fn(),
      newSuccess = vi.fn();
    vi.mocked(test.port.open).mockImplementationOnce(async () => {
      test.log.push("old-open-start");
      await pending.promise;
      test.log.push("old-open-end");
    });
    const first = new CallControlsHost(vi.fn(), vi.fn(), test.port, oldSuccess);
    first.update(entry(), vi.fn());
    first.setVisible(true);
    await flush();
    first.update(entry({ ownerKey: "stale-queued" }), vi.fn());
    first.dispose();
    const replacement = new CallControlsHost(vi.fn(), vi.fn(), test.port, newSuccess);
    replacement.update(entry({ ownerKey: "replacement" }), vi.fn());
    replacement.setVisible(true);
    pending.resolve();
    await flush();
    expect(test.log).not.toContain("publish:stale-queued");
    expect(test.log.slice(test.log.indexOf("old-open-end"))).toEqual([
      "old-open-end",
      "hide",
      "publish:replacement",
      "publish:replacement",
      "open",
    ]);
    expect(oldSuccess).not.toHaveBeenCalled();
    expect(newSuccess).toHaveBeenCalledOnce();
    first.dispose();
    await flush();
    expect(test.log[test.log.length - 1]).toBe("open");
    replacement.dispose();
    await flush();
  });

  it("cleans partially acquired listeners when another listener fails", async () => {
    const test = setup(),
      pending = deferred(),
      error = vi.fn();
    vi.mocked(test.port.listenClosed).mockImplementationOnce(async () => {
      await pending.promise;
      return vi.fn<() => void>();
    });
    const host = new CallControlsHost(error, vi.fn(), test.port);
    await flush();
    pending.reject(new Error("listen failed"));
    await flush();
    expect(test.unlisten[0]).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    host.update(entry(), vi.fn());
    host.setVisible(true);
    await flush();
    expect(test.port.open).not.toHaveBeenCalled();
  });

  it("does not open stale state after publication failure and can explicitly retry", async () => {
    const test = setup(),
      failure = vi.fn(),
      success = vi.fn();
    vi.mocked(test.port.publish).mockRejectedValue(
      new Error("Command call_controls_publish not found"),
    );
    const host = new CallControlsHost(failure, vi.fn(), test.port, success);
    host.update(entry(), vi.fn());
    host.setVisible(true);
    await flush();
    expect(test.port.open).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalled();
    host.setVisible(false);
    await flush();
    vi.mocked(test.port.publish).mockResolvedValue();
    host.setVisible(true);
    await flush();
    expect(test.port.open).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledOnce();
    host.dispose();
    await flush();
  });

  it("requires current admission and disables entry operations after connection", () => {
    const pending = entry({
      active: true,
      signalState: "pending",
      guest: { name: "GPT", requestId: "new" },
    });
    expect(callControlsActionAllowed(pending, { type: "accept", requestId: "old" })).toBe(false);
    expect(callControlsActionAllowed(pending, { type: "accept", requestId: "new" })).toBe(true);
    expect(callControlsActionAllowed({ ...pending, connected: true }, { type: "cancel" })).toBe(
      false,
    );
    expect(callControlsActionAllowed({ ...pending, busy: "accept" }, { type: "cancel" })).toBe(
      true,
    );
    expect(
      callControlsActionAllowed(entry(), { type: "join", name: "より", invitation: "invalid" }),
    ).toBe(false);
    expect(callControlsActionAllowed(entry(), { type: "create", name: "bad\nname" })).toBe(false);
  });
});

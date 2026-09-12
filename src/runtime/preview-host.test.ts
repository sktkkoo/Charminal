import { expect, it, vi } from "vitest";
import { type PreviewAction, PreviewHost, type PreviewOptions } from "./preview-host";

interface Model extends PreviewOptions {
  source: string | null;
  ready: boolean;
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
};
function fixture(overrides: Partial<Model> = {}) {
  const model: Model = {
    source: "a",
    ready: true,
    initiallyDetached: true,
    onStop: vi.fn(),
    ...overrides,
  };
  let action!: (request: PreviewAction) => void;
  let fail!: (error: unknown) => void;
  let publish!: (frame: string) => Promise<void>;
  const transport = {
    begin: vi.fn(async () => "lease-a"),
    open: vi.fn(async (_lease: string) => {}),
    show: vi.fn(async (_lease: string) => {}),
    revoke: vi.fn(async (_lease: string) => {}),
    publish: vi.fn(async (_frame: string) => {}),
    listen: vi.fn(async (callback: typeof action) => {
      action = callback;
      return vi.fn();
    }),
  };
  const cleanup = vi.fn();
  const relay = vi.fn(
    (
      _source: string,
      _model: () => Model,
      _lease: string,
      send: typeof publish,
      failed: typeof fail,
    ) => {
      publish = send;
      fail = failed;
      return cleanup;
    },
  );
  const changed = vi.fn();
  const host = new PreviewHost(
    model,
    changed,
    transport,
    {
      source: (value) => value.source,
      ready: (value) => value.ready,
      relay,
    },
    { pending: Promise.resolve() },
  );
  const opened = async (count = 1) => vi.waitFor(() => expect(relay).toHaveBeenCalledTimes(count));
  return {
    host,
    model,
    transport,
    changed,
    relay,
    cleanup,
    opened,
    action: (request: PreviewAction) => action(request),
    fail: (error: unknown) => fail(error),
    publish: (frame: string) => publish(frame),
  };
}
it("reveals an existing window on explicit detach without focusing automatic creation", async () => {
  const f = fixture();
  f.host.update(f.model);
  await f.opened();
  expect(f.transport.show).not.toHaveBeenCalled();
  await f.host.detach();
  expect(f.transport.show).toHaveBeenCalledWith("lease-a");
  expect(f.transport.open).toHaveBeenCalledOnce();
  expect(f.relay).toHaveBeenCalledOnce();
  f.host.dispose();
});
it("waits for a pending automatic open before an explicit reveal", async () => {
  const f = fixture();
  const pending = deferred<void>();
  f.transport.open.mockReturnValueOnce(pending.promise);
  f.host.update(f.model);
  await vi.waitFor(() => expect(f.transport.open).toHaveBeenCalledOnce());
  const reveal = f.host.detach();
  await Promise.resolve();
  expect(f.transport.show).not.toHaveBeenCalled();
  pending.resolve();
  await reveal;
  expect(f.transport.show).toHaveBeenCalledWith("lease-a");
  expect(f.transport.open).toHaveBeenCalledOnce();
  f.host.dispose();
});
it("never reveals a replacement owner for a click made during the previous open", async () => {
  const f = fixture();
  const pending = deferred<void>();
  f.transport.open.mockReturnValueOnce(pending.promise);
  f.host.update(f.model);
  await vi.waitFor(() => expect(f.transport.open).toHaveBeenCalledOnce());
  const reveal = f.host.detach();
  f.transport.begin.mockResolvedValue("lease-b");
  f.host.update({ ...f.model, source: "b" });
  pending.resolve();
  await reveal;
  await f.opened();
  expect(f.transport.open).toHaveBeenLastCalledWith("lease-b");
  expect(f.transport.show).not.toHaveBeenCalled();
  await f.host.detach();
  expect(f.transport.show).toHaveBeenCalledWith("lease-b");
  f.host.dispose();
});
it("reports reveal errors without revoking the active view and allows retry", async () => {
  const f = fixture();
  f.host.update(f.model);
  await f.opened();
  f.transport.show.mockRejectedValueOnce(new Error("reveal failed"));
  await expect(f.host.detach()).rejects.toThrow("reveal failed");
  expect(f.changed).toHaveBeenLastCalledWith({
    detached: true,
    opening: false,
    error: "Error: reveal failed",
  });
  expect(f.transport.revoke).not.toHaveBeenCalled();
  await f.host.detach();
  expect(f.changed).toHaveBeenLastCalledWith({ detached: true, opening: false });
  expect(f.transport.open).toHaveBeenCalledOnce();
  f.host.dispose();
});
it("keeps the session destination through hide/show and later mode changes", async () => {
  const f = fixture();
  f.host.update(f.model);
  await f.opened();
  f.host.update({ ...f.model, visible: false });
  expect(f.cleanup).toHaveBeenCalledOnce();
  f.host.update({ ...f.model, initiallyDetached: false });
  await f.opened(2);
  expect(f.transport.open).toHaveBeenCalledTimes(2);
  f.host.update({ ...f.model, initiallyDetached: false });
  expect(f.transport.open).toHaveBeenCalledTimes(2);
  f.host.dispose();
});
it("manual attach while hidden overrides the old detached destination", async () => {
  const f = fixture();
  f.host.update(f.model);
  await f.opened();
  f.host.update({ ...f.model, visible: false });
  await f.host.attach();
  f.host.update(f.model);
  await Promise.resolve();
  expect(f.transport.open).toHaveBeenCalledOnce();
  await f.host.detach();
  expect(f.transport.open).toHaveBeenCalledTimes(2);
  f.host.dispose();
});
it("waits for the first ready frame, then keeps an open window during crop updates", async () => {
  const f = fixture({ ready: false });
  f.host.update(f.model);
  expect(f.transport.begin).not.toHaveBeenCalled();
  f.host.update({ ...f.model, ready: true });
  await f.opened();
  f.host.update({ ...f.model, ready: false });
  expect(f.transport.revoke).not.toHaveBeenCalled();
  expect(f.cleanup).not.toHaveBeenCalled();
  f.host.dispose();
});
it("hide/show fences pending native open and reopens only after its cleanup", async () => {
  const f = fixture();
  const pending = deferred<void>();
  f.transport.open.mockReturnValueOnce(pending.promise);
  f.host.update(f.model);
  await vi.waitFor(() => expect(f.transport.open).toHaveBeenCalledOnce());
  f.host.update({ ...f.model, visible: false });
  expect(f.transport.revoke).toHaveBeenCalledWith("lease-a");
  f.transport.begin.mockResolvedValue("lease-b");
  f.host.update(f.model);
  expect(f.transport.open).toHaveBeenCalledOnce();
  pending.resolve();
  await f.opened();
  expect(f.transport.open).toHaveBeenLastCalledWith("lease-b");
  expect(f.relay).toHaveBeenCalledOnce();
  f.action({ leaseId: "lease-a", action: "stop" });
  expect(f.model.onStop).not.toHaveBeenCalled();
  f.host.dispose();
});
it("open failure does not retry on model updates, but an explicit detach can retry", async () => {
  const f = fixture();
  f.transport.open.mockRejectedValueOnce(new Error("unavailable"));
  f.host.update(f.model);
  await vi.waitFor(() =>
    expect(f.changed).toHaveBeenLastCalledWith({
      detached: false,
      opening: false,
      error: "Error: unavailable",
    }),
  );
  f.host.update({ ...f.model });
  f.host.update({ ...f.model });
  await Promise.resolve();
  expect(f.transport.open).toHaveBeenCalledOnce();
  await f.host.detach();
  expect(f.transport.open).toHaveBeenCalledTimes(2);
  f.host.dispose();
});
it("relay failure fences further publications without retrying on every frame", async () => {
  const f = fixture();
  f.host.update(f.model);
  await f.opened();
  f.fail(new Error("publish failed"));
  await f.publish("late image");
  f.host.update({ ...f.model });
  expect(f.transport.publish).not.toHaveBeenCalled();
  expect(f.transport.open).toHaveBeenCalledOnce();
  expect(f.cleanup).toHaveBeenCalledOnce();
  f.host.dispose();
});
it("native attach persists through visibility changes; a replacement initializes a fresh destination", async () => {
  const f = fixture();
  f.host.update(f.model);
  await f.opened();
  f.action({ leaseId: "lease-a", action: "attach" });
  f.host.update({ ...f.model, visible: false });
  f.host.update(f.model);
  expect(f.transport.open).toHaveBeenCalledOnce();
  f.host.update({ ...f.model, source: null });
  f.host.update({ ...f.model, source: "b" });
  await f.opened(2);
  f.host.dispose();
});
it("repeated visible and hidden updates do not emit redundant status changes", async () => {
  const f = fixture();
  f.host.update(f.model);
  await f.opened();
  f.changed.mockClear();
  f.host.update({ ...f.model });
  f.host.update({ ...f.model });
  expect(f.changed).not.toHaveBeenCalled();
  f.host.update({ ...f.model, visible: false });
  expect(f.changed).toHaveBeenCalledOnce();
  f.changed.mockClear();
  f.host.update({ ...f.model, visible: false });
  f.host.update({ ...f.model, visible: false });
  expect(f.changed).not.toHaveBeenCalled();
  f.host.dispose();
});

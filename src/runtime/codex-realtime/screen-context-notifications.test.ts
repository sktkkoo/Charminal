import { describe, expect, it, vi } from "vitest";
import { ScreenContextNotifications } from "./screen-context-notifications";

function deferred() {
  let resolve: () => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function owner() {
  const controller = new AbortController();
  return {
    controller,
    client: {},
    signal: controller.signal,
    notify: vi.fn(async (_capturedAt: string) => {}),
    isCurrent: vi.fn(() => true),
  };
}

describe("screen context metadata notifications", () => {
  it("keeps one in flight and coalesces waiting updates to the newest timestamp", async () => {
    const queue = new ScreenContextNotifications();
    const target = owner();
    const first = deferred();
    target.notify.mockReturnValueOnce(first.promise);
    queue.enqueue({ ...target, capturedAt: "first" });
    await flushMicrotasks();
    for (let index = 2; index <= 100; index += 1) {
      queue.enqueue({ ...target, capturedAt: `frame-${index}` });
    }
    expect(target.notify).toHaveBeenCalledExactlyOnceWith("first");
    first.resolve();
    await flushMicrotasks();
    expect(target.notify.mock.calls).toEqual([["first"], ["frame-100"]]);
  });

  it("discards a stopped share's queued update but accepts the replacement share", async () => {
    const queue = new ScreenContextNotifications();
    const target = owner();
    const first = deferred();
    target.notify.mockReturnValueOnce(first.promise);
    queue.enqueue({ ...target, capturedAt: "first" });
    await flushMicrotasks();
    queue.enqueue({ ...target, capturedAt: "stopped-share" });
    target.controller.abort();
    first.resolve();
    await flushMicrotasks();
    expect(target.notify).toHaveBeenCalledExactlyOnceWith("first");
    queue.enqueue({ ...target, signal: new AbortController().signal, capturedAt: "new-share" });
    await flushMicrotasks();
    expect(target.notify.mock.calls).toEqual([["first"], ["new-share"]]);
  });

  it("revalidates tracker/thread ownership immediately before a queued dispatch", async () => {
    const queue = new ScreenContextNotifications();
    const target = owner();
    const first = deferred();
    target.notify.mockReturnValueOnce(first.promise);
    queue.enqueue({ ...target, capturedAt: "first" });
    await flushMicrotasks();
    queue.enqueue({ ...target, capturedAt: "old-thread" });
    target.isCurrent.mockReturnValue(false);
    first.resolve();
    await flushMicrotasks();
    expect(target.notify).toHaveBeenCalledExactlyOnceWith("first");
  });

  it("does not let an old client's late ACK drain the replacement client's queue", async () => {
    const queue = new ScreenContextNotifications();
    const previous = owner();
    const previousAck = deferred();
    previous.notify.mockReturnValueOnce(previousAck.promise);
    queue.enqueue({ ...previous, capturedAt: "old-first" });
    await flushMicrotasks();
    queue.enqueue({ ...previous, capturedAt: "old-queued" });
    const current = owner();
    const currentAck = deferred();
    current.notify.mockReturnValueOnce(currentAck.promise);
    queue.enqueue({ ...current, capturedAt: "new-first" });
    await flushMicrotasks();
    queue.enqueue({ ...current, capturedAt: "new-latest" });
    previousAck.resolve();
    await flushMicrotasks();
    expect(previous.notify).toHaveBeenCalledExactlyOnceWith("old-first");
    expect(current.notify).toHaveBeenCalledExactlyOnceWith("new-first");
    currentAck.resolve();
    await flushMicrotasks();
    expect(current.notify.mock.calls).toEqual([["new-first"], ["new-latest"]]);
  });

  it("drops work on reset and tolerates synchronous and asynchronous notification failures", async () => {
    const queue = new ScreenContextNotifications();
    const target = owner();
    queue.enqueue({ ...target, capturedAt: "never-dispatched" });
    queue.reset();
    await flushMicrotasks();
    expect(target.notify).not.toHaveBeenCalled();
    target.notify.mockImplementationOnce(() => {
      throw new Error("private provider error");
    });
    queue.enqueue({ ...target, capturedAt: "sync-failure" });
    await flushMicrotasks();
    const failure = deferred();
    target.notify.mockReturnValueOnce(failure.promise);
    queue.enqueue({ ...target, capturedAt: "async-failure" });
    await flushMicrotasks();
    queue.enqueue({ ...target, capturedAt: "newest" });
    failure.reject(new Error("private provider error"));
    await flushMicrotasks();
    expect(target.notify.mock.calls).toEqual([["sync-failure"], ["async-failure"], ["newest"]]);
  });

  it("does not dispatch when a sharing signal aborts before the initial microtask", async () => {
    const queue = new ScreenContextNotifications();
    const target = owner();
    queue.enqueue({ ...target, capturedAt: "cancelled" });
    target.controller.abort();
    await flushMicrotasks();
    expect(target.notify).not.toHaveBeenCalled();
  });
});

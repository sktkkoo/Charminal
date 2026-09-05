import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenObservationTransport } from "./screen-observation";

const frame = {
  frameId: "frame-1",
  width: 2560,
  height: 1440,
  imageDataUrl: "data:image/jpeg;base64,YQ==",
  capturedAt: "2026-09-05T13:00:00.000Z",
  source: "Display 1",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const loaded = (status = "idle", id = "main") => ({ thread: { id, status: { type: status } } });
afterEach(() => vi.useRealTimers());

describe("screen observation transport", () => {
  it("injects the exact native frame reference and top-left image coordinate instructions", async () => {
    const request = vi.fn(async (method: string, _params: object) =>
      method === "thread/read" ? loaded() : {},
    );
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    await transport.observe(frame);
    const injection = request.mock.calls[1][1] as {
      items: Array<{ content: Array<{ text?: string }> }>;
    };
    const text = injection.items[0].content[0].text;
    expect(text).toContain('Frame reference: "frame-1"');
    expect(text).toContain("2560 x 1440 pixels");
    expect(text).toContain("screen_pointer_show");
    expect(text).toContain("normalized 0..1 from the screenshot TOP LEFT");
    expect(text).toContain("width/height must be positive and fit within the image");
    expect(text).toContain("screen_pointer_clear({})");
    expect(text).toContain("Only say it is displayed after the tool confirms success");
    expect(text).toContain("Do not initiate work, use tools");
  });

  it.each([
    { frameId: "" },
    { frameId: "x".repeat(129) },
    { width: 0 },
    { width: Number.NaN },
    { height: -1 },
    { height: 1.5 },
  ])("rejects unusable native image metadata %j before contacting the agent", async (metadata) => {
    const request = vi.fn();
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    await expect(transport.observe({ ...frame, ...metadata })).rejects.toThrow(
      "Invalid screen capture",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "idle",
    "active",
  ])("injects context in a %s thread without starting or steering work", async (status) => {
    const request = vi.fn(async (method: string) =>
      method === "thread/read" ? loaded(status) : {},
    );
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    expect((await transport.observe(frame)).status).toBe("shared");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/inject_items",
    ]);
    expect(request).toHaveBeenLastCalledWith(
      "thread/inject_items",
      expect.objectContaining({
        threadId: "main",
        items: [
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "input_image", image_url: frame.imageDataUrl }),
            ]),
          }),
        ],
      }),
    );
  });

  it("does not deliver after a cancelled preflight, and serializes a replacement", async () => {
    const read = deferred<unknown>();
    const request = vi.fn(() => read.promise);
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    const controller = new AbortController();
    const result = transport.observe(frame, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect((await transport.observe(frame)).status).toBe("busy");
    read.resolve(loaded());
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(transport.busy).toBe(false);
  });

  it("rejects stale thread results and redacts image-bearing backend errors", async () => {
    let id = "main";
    const request = vi.fn(async () => {
      id = "new-main";
      return loaded();
    });
    const transport = new ScreenObservationTransport({ request, getThreadId: () => id });
    await expect(transport.observe(frame)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
    const fail = new ScreenObservationTransport({
      getThreadId: () => "main",
      request: async () => {
        throw new Error(frame.imageDataUrl);
      },
    });
    await expect(fail.observe(frame)).rejects.toThrow("Could not check");
  });

  it("times out without creating a second outstanding RPC", async () => {
    vi.useFakeTimers();
    const read = deferred<unknown>();
    const transport = new ScreenObservationTransport({
      request: () => read.promise,
      getThreadId: () => "main",
      timeoutMs: 100,
    });
    const pending = expect(transport.observe(frame)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect((await transport.observe(frame)).status).toBe("busy");
    read.resolve(loaded());
    await Promise.resolve();
  });
});

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
afterEach(() => vi.useRealTimers());

describe("screen observation transport", () => {
  it("injects the exact native frame reference and top-left image coordinate instructions", async () => {
    const request = vi.fn(async (_method: string, _params: object) => ({}));
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    await transport.observe(frame);
    const injection = request.mock.calls[0][1] as {
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
    expect(text).toContain("latest actual attached shared-screen image before choosing a target");
    expect(text).toContain(
      "explicit where/which/point request, show the grounded target before a lengthy explanation",
    );
    expect(text).toContain("with the exact inspected frame reference");
    expect(text).toContain("Inspect the attached image directly");
    expect(text).toContain("app_screenshot captures only the Yorishiro window");
    expect(text).toContain(
      "the image is stale, or the target moved, inspect a fresh shared image before pointing again",
    );
    expect(text).toContain("No response is needed for the capture itself");
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
  it("shares with a validated main thread in one RPC without starting or steering work", async () => {
    const request = vi.fn(async (_method: string) => ({}));
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    expect((await transport.observe(frame)).status).toBe("shared");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/inject_items"]);
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

  it("suppresses a cancelled injection's late reply and serializes a replacement", async () => {
    const injection = deferred<unknown>();
    const request = vi.fn(() => injection.promise);
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    const controller = new AbortController();
    const result = transport.observe(frame, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect((await transport.observe(frame)).status).toBe("busy");
    injection.resolve({});
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(transport.busy).toBe(false);
  });

  it("does not send for an unloaded owner or an already cancelled sharing lease", async () => {
    const request = vi.fn();
    let threadId: string | null = null;
    const transport = new ScreenObservationTransport({ request, getThreadId: () => threadId });
    expect((await transport.observe(frame)).status).toBe("busy");
    threadId = "main";
    const controller = new AbortController();
    controller.abort();
    await expect(transport.observe(frame, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("finishes after one transport round trip even when a redundant preflight would be slow", async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      (_method: string) => new Promise((resolve) => setTimeout(() => resolve({}), 80)),
    );
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    const completed = vi.fn();
    void transport.observe(frame).then(completed);
    await vi.advanceTimersByTimeAsync(79);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledWith({ status: "shared", capturedAt: frame.capturedAt });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects stale thread results and redacts image-bearing backend errors", async () => {
    let id = "main";
    const request = vi.fn(async () => {
      id = "new-main";
      return {};
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
    await expect(fail.observe(frame)).rejects.toThrow("Could not share");
  });

  it("times out without creating a second outstanding RPC", async () => {
    vi.useFakeTimers();
    const injection = deferred<unknown>();
    const transport = new ScreenObservationTransport({
      request: () => injection.promise,
      getThreadId: () => "main",
      timeoutMs: 100,
    });
    const pending = expect(transport.observe(frame)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect((await transport.observe(frame)).status).toBe("busy");
    injection.resolve({});
    await Promise.resolve();
  });
});

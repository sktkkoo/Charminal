// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useQuickChatDrafts } from "./use-quick-chat-drafts";

afterEach(cleanup);

describe("work and call QuickChat drafts", () => {
  it("hides work text before admission and restores it after cancel or call end", () => {
    const hook = renderHook(({ owner }: { owner: string | null }) => useQuickChatDrafts(owner), {
      initialProps: { owner: null as string | null },
    });
    act(() => hook.result.current.setValue("private work draft"));
    hook.rerender({ owner: "call-one" });
    expect(hook.result.current.value).toBe("");
    act(() => hook.result.current.setValue("call-only draft"));
    expect(hook.result.current.value).toBe("call-only draft");
    hook.rerender({ owner: null });
    expect(hook.result.current.value).toBe("private work draft");
    hook.rerender({ owner: "call-two" });
    expect(hook.result.current.value).toBe("");
  });

  it("does not let stale input or completion callbacks overwrite a newer draft", () => {
    const hook = renderHook(({ owner }: { owner: string | null }) => useQuickChatDrafts(owner), {
      initialProps: { owner: null as string | null },
    });
    act(() => hook.result.current.setValue("work"));
    const oldWorkSetter = hook.result.current.setValue;
    hook.rerender({ owner: "call-one" });
    const oldCallSetter = hook.result.current.setValue;
    hook.rerender({ owner: "call-two" });
    act(() => hook.result.current.setValue("new call"));
    act(() => {
      oldWorkSetter("leaked work text");
      oldCallSetter("");
    });
    expect(hook.result.current.value).toBe("new call");
    hook.rerender({ owner: null });
    expect(hook.result.current.value).toBe("work");
  });
});

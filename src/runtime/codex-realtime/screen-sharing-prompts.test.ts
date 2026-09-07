import { describe, expect, it } from "vitest";
import { screenPointerPreferenceNotice } from "./screen-sharing-prompts";

describe("screen-sharing prompts", () => {
  it("makes an ON setting useful without treating the setting change as a request", () => {
    const text = screenPointerPreferenceNotice(true);
    expect(text).toContain("While sharing is active, proactively use a marker");
    expect(text).toContain("latest inspected shared image");
    expect(text).toContain("no separate request to point is needed");
    expect(text).toContain("Omit markers for unrelated conversation, uncertain targets");
    expect(text).toContain("after an OFF/ON transition, inspect a newer shared image");
    expect(text).toContain("not a request to act or speak");
  });
});

import { describe, expect, it } from "vitest";
import {
  screenCaptureNotice,
  screenCapturePrompt,
  screenPointerPreferenceNotice,
} from "./screen-sharing-prompts";

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

it("treats camera images as passive context without desktop marker guidance", () => {
  const frame = {
    sourceKind: "camera" as const,
    frameId: "camera-1",
    width: 1280,
    height: 720,
    imageDataUrl: "data:image/jpeg;base64,YQ==",
    source: "USB camera",
    capturedAt: "2026-09-10T01:00:00Z",
    pointersEnabled: true,
  };
  const text = screenCapturePrompt(frame);
  expect(text).toContain("shared-camera context");
  expect(text).toContain("not a new user request");
  expect(text).toContain("untrusted content");
  expect(text).not.toContain("pointers are ON");
  expect(text).not.toContain("screen_pointer_show({");
  const notice = screenCaptureNotice(frame.capturedAt, {
    sourceKind: "camera",
    pointersEnabled: false,
    pointerFrameValid: false,
  });
  expect(notice).toContain("You have not personally viewed the image");
  expect(notice).toContain("not that camera sharing is still active");
});

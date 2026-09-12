// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  listen: vi.fn(),
  read: vi.fn(),
  show: vi.fn(),
  request: vi.fn(),
}));
vi.mock("./runtime/screen-preview-window", () => ({
  listenScreenPreview: bridge.listen,
  readScreenPreview: bridge.read,
  showScreenPreview: bridge.show,
  requestScreenPreviewAction: bridge.request,
}));

import AuxiliaryScreenPreview from "./auxiliary-screen-preview";

afterEach(cleanup);
it("shows the external window only after its image loads, without waiting text", async () => {
  bridge.listen.mockResolvedValue(() => {});
  bridge.read.mockResolvedValue({
    leaseId: "lease",
    imageDataUrl: "data:image/jpeg;base64,AAAA",
    language: "ja",
  });
  bridge.show.mockResolvedValue(undefined);
  render(<AuxiliaryScreenPreview />);
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {});
  expect(bridge.show).not.toHaveBeenCalled();
  await act(async () => fireEvent.load(screen.getByRole("img")));
  expect(bridge.show).toHaveBeenCalledExactlyOnceWith("lease");
  await act(async () => fireEvent.load(screen.getByRole("img")));
  expect(bridge.show).toHaveBeenCalledTimes(1);
});

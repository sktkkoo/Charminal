import { expect, it } from "vitest";
import { enqueueConfigWrite } from "./config-write-queue";

it("continues with the next config update after an earlier write fails", async () => {
  const first = enqueueConfigWrite(async () => {
    throw new Error("Disk unavailable");
  });
  const second = enqueueConfigWrite(async () => "saved");
  await expect(first).rejects.toThrow("Disk unavailable");
  await expect(second).resolves.toBe("saved");
});

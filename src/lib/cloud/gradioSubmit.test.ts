import { describe, it, expect } from "vitest";
import type { Client } from "@gradio/client";
import { submitWithProgress } from "./gradioSubmit";

function buildIterable(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    cancel: async () => {},
  };
}

describe("submitWithProgress", () => {
  it("returns data and emits progress", async () => {
    const client = {
      submit: () =>
        buildIterable([
          { type: "status", stage: "pending", progress_data: [{ progress: 0.25, desc: "step" }] },
          { type: "data", data: { ok: true } },
          { type: "status", stage: "complete" },
        ]),
    } as unknown as Client;

    let seen = false;
    const result = await submitWithProgress<{ ok: boolean }>(client, "/test", {}, {
      onProgress: (update) => {
        seen = true;
        expect(update.progress).toBeCloseTo(0.25, 3);
      },
    });
    expect(seen).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(result.progressSeen).toBe(true);
  });

  it("throws on error status", async () => {
    const client = {
      submit: () =>
        buildIterable([
          { type: "status", stage: "error", message: "boom" },
        ]),
    } as unknown as Client;

    await expect(submitWithProgress(client, "/test", {})).rejects.toBeTruthy();
  });
});

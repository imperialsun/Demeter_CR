import { describe, it, expect } from "vitest";
import { buildBatchPlan, DEFAULT_BATCH_DURATION_SEC } from "./batchPlan";

describe("buildBatchPlan", () => {
  it("returns one batch for short duration", () => {
    const plan = buildBatchPlan(60);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.start).toBe(0);
    expect(plan[0]?.end).toBe(60);
  });

  it("splits into 45-minute batches", () => {
    const duration = DEFAULT_BATCH_DURATION_SEC * 2 + 30;
    const plan = buildBatchPlan(duration);
    expect(plan).toHaveLength(3);
    expect(plan[0]?.end).toBe(DEFAULT_BATCH_DURATION_SEC);
    expect(plan[1]?.start).toBe(DEFAULT_BATCH_DURATION_SEC);
    expect(plan[1]?.end).toBe(DEFAULT_BATCH_DURATION_SEC * 2);
    expect(plan[2]?.end).toBe(duration);
  });
});

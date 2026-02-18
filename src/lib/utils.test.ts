import { describe, expect, it } from "vitest";

import { cn, overallConfidenceVariant } from "./utils";

describe("utils", () => {
  it("merges class names with tailwind precedence", () => {
    expect(cn("p-2", "text-sm", "p-4", undefined, null, "font-medium")).toBe(
      "text-sm p-4 font-medium"
    );
  });

  it("maps confidence score to badge variants", () => {
    expect(overallConfidenceVariant(null)).toBe("outline");
    expect(overallConfidenceVariant(0.65)).toBe("success");
    expect(overallConfidenceVariant(0.61)).toBe("warning");
    expect(overallConfidenceVariant(0.2)).toBe("destructive");
  });
});

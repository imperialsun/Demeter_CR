import { describe, expect, it } from "vitest";
import { moveArrayItem } from "@/lib/arrayMove";

describe("moveArrayItem", () => {
  it("moves an item to a later position", () => {
    expect(moveArrayItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves an item to an earlier position", () => {
    expect(moveArrayItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("returns a copy when the indices are invalid or identical", () => {
    const items = ["a", "b"];
    expect(moveArrayItem(items, -1, 1)).toEqual(items);
    expect(moveArrayItem(items, 1, 1)).toEqual(items);
    expect(moveArrayItem(items, 5, 0)).toEqual(items);
  });
});

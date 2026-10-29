import { describe, expect, it } from "vitest";
import { tagTree } from "./Panels";

describe("tagTree", () => {
  it("nests #a/b/c tags under their parents", () => {
    const tree = tagTree(["trip/goa", "trip", "work/q4/plan", "trip/delhi"]);
    expect(tree.map((n) => n.path)).toEqual(["trip", "work"]);
    expect(tree[0].children.map((n) => n.path)).toEqual(["trip/delhi", "trip/goa"]);
    expect(tree[1].children[0].children[0].path).toBe("work/q4/plan");
  });
});

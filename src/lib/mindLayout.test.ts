import { describe, expect, it } from "vitest";
import { arrange } from "./mindLayout";
import { emptyMap, ROOT_ID, type MindMap } from "./mindmap";

const map = (): MindMap => {
  const m = emptyMap();
  const add = (id: string, parent: string) => m.nodes.push({ id, label: id, kind: "idea", parent, firstSeenDay: "2026-11-01", lastSeenDay: "2026-11-01", weight: 1, days: [] });
  add("a", ROOT_ID);
  add("b", ROOT_ID);
  add("a1", "a");
  add("a2", "a");
  add("lost", "gone");
  return m;
};

describe("mind map layouts", () => {
  it("places every node in each layout", () => {
    for (const l of ["radial", "right", "left", "org", "logic"] as const) expect(arrange(map(), l).size).toBe(6);
  });
  it("right tree grows right, left tree grows left, org chart grows down", () => {
    expect(arrange(map(), "right").get("a1")!.x).toBeGreaterThan(arrange(map(), "right").get("a")!.x);
    expect(arrange(map(), "left").get("a1")!.x).toBeLessThan(0);
    const org = arrange(map(), "org");
    expect(org.get("a1")!.y).toBeGreaterThan(org.get("a")!.y);
    // A parent sits centred over its children.
    expect(org.get("a")!.x).toBe((org.get("a1")!.x + org.get("a2")!.x) / 2);
  });
  it("radial keeps the root in the middle and children on a ring", () => {
    const r = arrange(map(), "radial");
    expect(r.get(ROOT_ID)).toEqual({ x: 0, y: 0 });
    expect(Math.round(Math.hypot(r.get("b")!.x, r.get("b")!.y))).toBe(150);
  });
});

import { describe, expect, it } from "vitest";
import { ganttRows } from "./GanttView";

describe("gantt rows", () => {
  it("planned steps span their plans, unplanned ones follow the step before, loose plans last", () => {
    const h = 3_600_000;
    const now = new Date(2026, 10, 13, 10).getTime();
    const t = {
      tid: "t", title: "3d", endAt: now + 48 * h, layer: "avg", awake: false, note: "2026-11-13", prefs: "",
      rows: [{ day: "2026-11-13", plans: [{ id: "p1", start: now + h, end: now + 3 * h, text: "a", step: "s1" }, { id: "p2", start: now + 5 * h, end: now + 6 * h, text: "loose" }], comments: [], between: [] }],
      info: { color: "#3b9be0", emoji: "🚀", status: "", steps: [{ id: "s1", text: "Plan", mins: 60 }, { id: "s2", text: "Build", mins: 120 }] },
    } as never;
    const rows = ganttRows(t, now);
    expect(rows.map((r) => r.title)).toEqual(["🚀 3d", "Plan", "Build", "loose"]);
    expect(rows[2].start).toBe(now + 3 * h);
    expect(rows[2].end).toBe(now + 5 * h);
    expect(rows[2].planned).toBe(false);
  });
});

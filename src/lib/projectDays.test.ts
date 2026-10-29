import { describe, expect, it } from "vitest";
import { dayColor, entryFor, gapDays, numberEntries } from "./projectDays";

describe("project day counter", () => {
  it("counts entries, not calendar days, from a hand-set start", () => {
    const n = numberEntries([
      { day: "2026-11-30", lines: ["c"] },
      { day: "2026-10-29", lines: ["a"], manual: 57 },
      { day: "2026-10-30", lines: ["b"] },
    ]);
    expect(n.map((e) => [e.day, e.n])).toEqual([["2026-10-29", 57], ["2026-10-30", 58], ["2026-11-30", 59]]);
  });

  it("lists the missing days between entries", () => {
    expect(gapDays("2026-10-30", "2026-11-30")).toHaveLength(30);
    expect(gapDays("2026-10-30", "2026-10-31")).toEqual([]);
  });

  it("reads a Day set in Block info, and colours days by month (light → dark)", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", attrs: { info: { Day: "57" } }, content: [{ type: "text", text: "[[Trip]] start" }] }] };
    expect(entryFor("2026-10-29", doc, "Trip")?.manual).toBe(57);
    expect(dayColor("2026-10-01")).toBe("rgb(169, 230, 166)");
    expect(dayColor("2026-10-31")).toBe("rgb(74, 154, 58)");
  });
});

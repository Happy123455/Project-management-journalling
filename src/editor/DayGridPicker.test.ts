import { describe, expect, it } from "vitest";
import { canPick, monthCells } from "./DayGridPicker";

describe("month-grid day picker", () => {
  it("lays a month in weeks starting on Sunday", () => {
    const cells = monthCells(2026, 10); // November 2026 starts on a Sunday
    expect(cells[0]).toBe("2026-11-01");
    expect(cells.length % 7).toBe(0);
    expect(cells.filter(Boolean)).toHaveLength(30);
    expect(monthCells(2026, 11).indexOf("2026-12-01")).toBe(2); // a Tuesday
  });
  it("only the allowed days, never before the first day", () => {
    expect(canPick("2026-11-18", { allowed: new Set(["2026-11-18"]) })).toBe(true);
    expect(canPick("2026-11-19", { allowed: new Set(["2026-11-18"]) })).toBe(false);
    expect(canPick("2026-11-15", { min: "2026-11-16" })).toBe(false);
    expect(canPick("2026-11-16", { min: "2026-11-16" })).toBe(true);
  });
});

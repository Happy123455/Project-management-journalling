import { describe, expect, it } from "vitest";
import { relativeLabel, relativeTo } from "./relative";

describe("relative time", () => {
  it("breaks a past day into years, months and days", () => {
    expect(relativeTo("2024-07-15", "2026-10-31")).toMatchObject({ years: 2, months: 3, days: 16, future: false });
    expect(relativeLabel("2024-07-15", "2026-10-31")).toBe("2 years, 3 months and 16 days ago");
  });
  it("borrows the right month length", () => {
    expect(relativeTo("2026-01-31", "2026-03-01")).toMatchObject({ years: 0, months: 1, days: 1 });
  });
  it("future days and the near ones", () => {
    expect(relativeLabel("2026-11-05", "2026-10-31")).toBe("in 5 days");
    expect(relativeLabel("2027-12-01", "2026-10-31")).toBe("in 1 year, 1 month and 1 day");
    expect(relativeLabel("2026-10-30", "2026-10-31")).toBe("Yesterday");
    expect(relativeLabel("2026-10-31", "2026-10-31")).toBe("Today");
    expect(relativeTo("2026-10-29", "2026-10-31").total).toBe(2);
  });
});

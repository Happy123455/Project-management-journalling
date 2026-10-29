import { describe, expect, it } from "vitest";
import { daysBetween } from "./Upcoming";

describe("daysBetween", () => {
  it("counts whole days, across month ends", () => {
    expect(daysBetween("2026-10-29", "2026-10-30")).toBe(1);
    expect(daysBetween("2026-10-29", "2026-11-28")).toBe(30);
    expect(daysBetween("2026-10-29", "2026-10-29")).toBe(0);
  });
});

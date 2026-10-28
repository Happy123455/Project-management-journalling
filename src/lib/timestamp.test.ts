import { describe, expect, it } from "vitest";
import { addDays, dayKey, dayTitle, formatTimestamp } from "./timestamp";

describe("timestamp", () => {
  it("formats the one-click timestamp", () => {
    expect(formatTimestamp(new Date(2026, 9, 27, 22, 4, 26))).toBe("27,October,2026 Tuesday (22:04:26)");
  });

  it("builds day keys and moves across month ends", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("titles a daily page", () => {
    expect(dayTitle("2026-10-27")).toBe("Tuesday, 27 October 2026");
  });
});

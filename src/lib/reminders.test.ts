import { describe, expect, it } from "vitest";
import { buildAlarms, nextOccurrence, occurrences, stepDay, timesIn } from "./reminders";

const doc = (...lines: string[]) => ({ type: "doc", content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });

describe("reminders", () => {
  it("finds times written in a line, but not the timestamp of when it was written", () => {
    expect(timesIn("dentist 15:30")).toEqual([{ hour: 15, minute: 30 }]);
    expect(timesIn("call mom 3pm")).toEqual([{ hour: 15, minute: 0 }]);
    expect(timesIn("gym at 6:45 am")).toEqual([{ hour: 6, minute: 45 }]);
    expect(timesIn("meet at 4")).toEqual([{ hour: 16, minute: 0 }]);
    expect(timesIn("27,October,2026 Tuesday (22:04:26) buy milk")).toEqual([]);
    expect(timesIn("score was 3-2")).toEqual([]);
  });

  it("repeats keep the date, month ends fall on the last day", () => {
    expect(stepDay("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(stepDay("2024-02-29", "yearly")).toBe("2025-02-28");
    expect(nextOccurrence("2020-11-05", "yearly", "2026-11-01")).toBe("2026-11-05");
    expect(nextOccurrence("2026-10-01", "weekly", "2026-11-01")).toBe("2026-11-05");
    expect(occurrences("2026-10-30", "weekly", "2026-11-01", "2026-11-30")).toEqual(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
  });

  it("gives one notification per time, and a morning one when no time is written", () => {
    const now = new Date(2026, 10, 1, 10, 0);
    const alarms = buildAlarms(
      [
        { day: "2026-11-03", content: doc("dentist 15:30 with [[Ravi]]", "bring card") },
        { day: "2026-11-04", content: doc("pay rent") },
        { day: "2026-10-01", content: doc("water plants"), repeat: "weekly" },
      ],
      now,
      { days: 7 },
    );
    expect(alarms.map((a) => [new Date(a.at).toString().slice(4, 21), a.body])).toEqual([
      ["Nov 03 2026 15:30", "dentist 15:30 with Ravi"],
      ["Nov 04 2026 08:00", "pay rent"],
      ["Nov 05 2026 08:00", "water plants"],
    ]);
  });
});

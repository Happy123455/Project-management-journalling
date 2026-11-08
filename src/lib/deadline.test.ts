import { describe, expect, it } from "vitest";
import { busyOn, dayLabel, daysBetween, freeGaps, midnight, shownRange } from "./deadline";
import { DEFAULT_ROUTINE, type StepStats } from "./routine";

const H = 3_600_000;
const st = (start: number | null, minutes = 0): StepStats => ({ start, minutes, often: 1, days: 10 });
// Minutes after 04:00: wake 08:00 (240), breakfast 09:00 for 20 min, sleep 23:30 (1170).
const stats = new Map<string, StepStats>([
  ["wake", st(240)],
  ["breakfast", st(300, 20)],
  ["work", st(360, 180)],
  ["sleep", st(1170)],
]);

describe("deadline bar", () => {
  it("covers each calendar day to the deadline, weekends marked", () => {
    expect(daysBetween("2026-11-08", "2026-11-10")).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
    expect(dayLabel("2026-11-08")).toEqual({ text: "Sun 8 Nov", weekend: true });
    expect(dayLabel("2026-11-09").weekend).toBe(false);
  });
  it("lays the usual routine on a day: sleep across midnight, work left free", () => {
    const busy = busyOn("2026-11-09", "avg", DEFAULT_ROUTINE, stats, new Map());
    const t0 = midnight("2026-11-09");
    expect(busy.map((b) => [b.label, (b.start - t0) / H, (b.end - t0) / H])).toEqual([
      ["Sleep", 0, 8],
      ["Breakfast", 9, 9 + 20 / 60],
      ["Sleep", 23.5, 24],
    ]);
    expect(shownRange("2026-11-09", busy, true).map((t) => (t - t0) / H)).toEqual([8, 23.5]);
    const free = freeGaps(t0 + 8 * H, t0 + 23.5 * H, busy);
    expect(free.map((f) => [(f.start - t0) / H, (f.end - t0) / H])).toEqual([[8, 9], [9 + 20 / 60, 23.5]]);
  });
});

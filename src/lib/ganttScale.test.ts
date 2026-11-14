import { describe, expect, it } from "vitest";
import { anchoredScroll, clampZoom, inHistory, levelFor, MAX_PX_PER_DAY, scaleTicks } from "./ganttScale";

const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 11, 14, 15);

describe("Gantt scale", () => {
  it("zoom levels go from hours to months", () => {
    expect(levelFor(480)).toBe("hour");
    expect(levelFor(46)).toBe("day");
    expect(levelFor(14)).toBe("week");
    expect(levelFor(3)).toBe("month");
    expect(clampZoom(1e6)).toBe(MAX_PX_PER_DAY);
    expect(clampZoom(1, 20)).toBe(20);
  });

  it("ticks: days with weekdays and today, hours when zoomed in, Monday weeks, months", () => {
    const days = scaleTicks(at(2026, 11, 12), at(2026, 11, 16), 46, NOW);
    expect(days.minor.map((t) => t.label)).toEqual(["12", "13", "14", "15", "16"]);
    expect(days.minor.find((t) => t.today)?.label).toBe("14");
    expect(days.bands.filter((b) => b.kind === "weekend")).toHaveLength(2); // Sat 14, Sun 15
    expect(days.major[0].label).toBe("Nov 2026");
    const hours = scaleTicks(at(2026, 11, 14), at(2026, 11, 14, 23), 480, NOW);
    expect(hours.minor.map((t) => t.label).slice(0, 3)).toEqual(["00:00", "02:00", "04:00"]);
    const weeks = scaleTicks(at(2026, 11, 1), at(2026, 11, 30), 14, NOW);
    expect(new Date(weeks.minor[0].t).getDay()).toBe(1);
    expect(weeks.minor.some((t) => t.today)).toBe(true);
    const months = scaleTicks(at(2026, 10, 5), at(2027, 2, 1), 3, NOW);
    expect(months.minor.map((t) => t.label)).toEqual(["Oct", "Nov", "Dec", "Jan", "Feb"]);
    expect(months.major.map((t) => t.label)).toEqual(["2026", "2027"]);
  });

  it("zooming keeps the moment under the fingers in place", () => {
    // 10 days scrolled in, fingers 200 px into the chart: day 10 + 200/46.
    const left = anchoredScroll(460, 200, 46, 92);
    expect((left + 200) / 92).toBeCloseTo((460 + 200) / 46, 6);
    expect(anchoredScroll(0, 0, 46, 10)).toBe(0);
  });

  it("History: done, archived, past, or every step done", () => {
    const t = (status: string, endAt: number, steps?: { done?: boolean }[]) => ({ endAt, info: { status, steps } });
    expect(inHistory(t("", NOW + 1000), NOW)).toBe(false);
    expect(inHistory(t("done", NOW + 1000), NOW)).toBe(true);
    expect(inHistory(t("archived", NOW + 1000), NOW)).toBe(true);
    expect(inHistory(t("", NOW - 1), NOW)).toBe(true);
    expect(inHistory(t("", NOW + 1000, [{ done: true }, { done: true }]), NOW)).toBe(true);
    expect(inHistory(t("", NOW + 1000, [{ done: true }, {}]), NOW)).toBe(false);
  });
});

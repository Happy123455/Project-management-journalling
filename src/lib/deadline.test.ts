import { describe, expect, it } from "vitest";
import { busyOn, dayLabel, daysBetween, firstFit, freeAcross, freeGaps, infoOf, midnight, missedPlans, needMins, nextFreeSlot, nextRepeat, overlaps, parseDuration, progressOf, pushLater, reviewOf, shownRange, snapTime, splitPlan, type Plan } from "./deadline";
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

describe("deadline round 3", () => {
  const M = 60_000;
  const t0 = midnight("2026-11-09");
  const plan = (id: string, s: number, e: number, extra: Partial<Plan> = {}): Plan => ({ id, start: t0 + s * H, end: t0 + e * H, text: id, ...extra });

  it("reads durations like people type them", () => {
    expect(parseDuration("1h 30")).toBe(90);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1:15")).toBe(75);
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("soon")).toBeNull();
  });

  it("snaps to the grid, or clicks onto a nearby edge", () => {
    const edge = t0 + 10 * H + 7 * M;
    expect(snapTime(t0 + 10 * H + 9 * M, 5, [edge], 3 * M)).toEqual({ t: edge, edge: true });
    expect(snapTime(t0 + 10 * H + 13 * M, 5, [edge], 3 * M)).toEqual({ t: t0 + 10 * H + 15 * M, edge: false });
  });

  it("pushes overlapped plans later, keeping their order, never done ones", () => {
    const list = [plan("a", 10, 11), plan("b", 10.5, 11.5), plan("c", 11.5, 12), plan("d", 10.75, 11, { done: true })];
    const out = pushLater(list, "a");
    const at = (id: string) => out.find((p) => p.id === id)!;
    expect([(at("b").start - t0) / H, (at("c").start - t0) / H]).toEqual([11, 12]);
    expect(at("d").start).toBe(list[3].start);
    expect(overlaps(list, new Set(["a"]))).toBe(true);
  });

  it("splits a plan and finds the next free slot", () => {
    const [x, y] = splitPlan(plan("a", 10, 12, { actual: [{ start: 0, end: 1 }] }), t0 + 11 * H, "b")!;
    expect([x.end, y.start, y.id, x.actual]).toEqual([t0 + 11 * H, t0 + 11 * H, "b", undefined]);
    expect(splitPlan(plan("a", 10, 12), t0 + 13 * H, "b")).toBeNull();
    expect(nextFreeSlot(H, t0 + 9 * H, t0 + 14 * H, [plan("p", 9, 10.5), plan("q", 11, 13)])).toBe(t0 + 13 * H);
    const gaps = freeAcross(["2026-11-09", "2026-11-10"], () => [], [plan("p", 0, 20)], t0, t0 + 30 * H);
    expect(gaps.map((g) => [(g.start - t0) / H, (g.end - t0) / H])).toEqual([[20, 24], [24, 30]]);
    expect(firstFit(gaps, 5 * H, t0)).toBe(t0 + 24 * H);
  });

  it("tells whether the work still fits", () => {
    const now = t0 + 12 * H;
    const plans = [plan("a", 9, 11, { done: true }), plan("b", 10, 11), plan("c", 13, 15), plan("d", 8, 8.5, { actual: [{ start: t0 + 8 * H, end: t0 + 8 * H + 20 * M }] })];
    const p = progressOf(plans, 6 * H, now, 2 * H);
    expect([p.done, p.planned, p.short]).toEqual([2 * H + 20 * M, 2 * H, H + 40 * M]);
    expect(p.status).toBe("behind");
    expect(progressOf(plans, 6 * H, now, 10 * H).status).toBe("tight");
    expect(progressOf(plans, 4 * H, now, 0).status).toBe("ok");
    expect(missedPlans(plans, now).map((x) => x.id)).toEqual(["b"]);
    expect(needMins({ need: 0, steps: [{ id: "s", text: "x", mins: 30 }, { id: "t", text: "y", mins: 45 }] })).toBe(75);
  });

  it("reviews plan vs actual per step, and repeats a deadline", () => {
    const rows = reviewOf([{ id: "s", text: "Draft", mins: 60, done: true }], [plan("a", 9, 10, { step: "s", actual: [{ start: t0, end: t0 + 90 * M }] }), plan("b", 11, 12)]);
    expect(rows.map((r) => [r.text, r.estimate / M, r.planned / M, r.spent / M])).toEqual([["Draft", 60, 60, 90], ["Other plans", 0, 60, 0]]);
    expect(dayLabel(dayKeyOf(nextRepeat(t0, "weekly"))).text).toBe("Mon 16 Nov");
    expect(infoOf({ tid: "t" })).toMatchObject({ emoji: "⏳", remind: 10, snap: 5, dueAlerts: true, steps: [] });
  });
});

const dayKeyOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("plan lanes", () => {
  it("overlapping plans go to the next free lane; a dragged lane is kept", async () => {
    const { planLanes } = await import("./deadline");
    const h = 3_600_000;
    const lanes = planLanes([
      { id: "a", start: 0, end: 2 * h, text: "a" },
      { id: "b", start: h, end: 3 * h, text: "b" },
      { id: "c", start: 2 * h, end: 4 * h, text: "c" },
      { id: "d", start: 5 * h, end: 6 * h, text: "d", row: 2 },
    ]);
    expect([...lanes.entries()].sort()).toEqual([["a", 0], ["b", 1], ["c", 0], ["d", 2]]);
  });
});

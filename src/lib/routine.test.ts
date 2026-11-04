import { describe, expect, it } from "vitest";
import { formatTimestamp } from "./timestamp";
import {
  buildDays, dayMinute, DEFAULT_ROUTINE, entriesIn, fillDay, freeMinutes, logLine, matchEntry, phaseSummaries, planRest,
  predict, restCheck, routineDay, routineStats, smooth, usualMinutes, withLogLine, deviation, minuteClock, clockMinute,
  habitSeries, buckets, weekStart, type Entry, type RoutineConfig,
} from "./routine";

const C = DEFAULT_ROUTINE;
const at = (day: string, hhmm: string) => {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
};
const doc = (lines: string[]) => ({ type: "doc", content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) });

describe("matchEntry", () => {
  it("reads steps, edges and habits", () => {
    expect(matchEntry("🪥 Brush start", C)).toEqual({ kind: "step", id: "brush", edge: "start" });
    expect(matchEntry("Finish breakfast", C)).toEqual({ kind: "step", id: "breakfast", edge: "end" });
    expect(matchEntry("💻 Work / study end", C)).toEqual({ kind: "step", id: "work", edge: "end" });
    expect(matchEntry("Wake up", C)).toEqual({ kind: "step", id: "wake", edge: "point" });
    expect(matchEntry("💧 Water", C)).toEqual({ kind: "habit", id: "water", edge: "point" });
    expect(matchEntry("🏋️ Exercise start (Samsung Health)", C)).toEqual({ kind: "step", id: "exercise", edge: "start", health: true });
  });
  it("a span step ticked without start/end is done now", () => {
    expect(matchEntry("Breakfast", C)?.edge).toBe("end");
  });
  it("journal writing isn't a log", () => {
    expect(matchEntry("Lunch with Sam was fun", C)).toBeNull();
    expect(matchEntry("Wake up early tomorrow please", C)).toBeNull();
    expect(matchEntry("thinking about work", C)).toBeNull();
  });
  it("old names still count", () => {
    const c: RoutineConfig = { ...C, steps: C.steps.map((s) => (s.id === "bath" ? { ...s, label: "Shower", aliases: ["Bath"] } : s)) };
    expect(matchEntry("Bath start", c)?.id).toBe("bath");
    expect(matchEntry("Shower start", c)?.id).toBe("bath");
  });
});

describe("log lines", () => {
  it("round-trips a tap", () => {
    const line = logLine(new Date(2026, 10, 4, 7, 12, 3), C.steps[1], "start");
    expect(line).toBe("4,November,2026 Wednesday (07:12:03) 🪥 Brush start");
    const e = entriesIn(doc([line]), C);
    expect(e).toEqual([{ kind: "step", id: "brush", edge: "start", time: new Date(2026, 10, 4, 7, 12, 3).getTime() }]);
  });
  it("adds into the Routine box, keeping the rest of the note", () => {
    let d = withLogLine(doc(["hello"]), "A");
    expect(d.content!.map((b) => b.content?.[0]?.text)).toEqual(["hello", "[[Routine]]", "A"]);
    d = withLogLine({ type: "doc", content: [...d.content!, { type: "paragraph", content: [{ type: "text", text: "later" }] }] }, "B");
    expect(d.content!.map((b) => b.content?.[0]?.text)).toEqual(["hello", "[[Routine]]", "A", "B", "later"]);
    expect(d.content![3].attrs).toEqual({ indent: 1 });
  });
});

describe("days", () => {
  it("after midnight belongs to the evening before", () => {
    expect(routineDay(at("2026-11-05", "00:30"))).toBe("2026-11-04");
    expect(dayMinute(at("2026-11-05", "00:30"))).toBeGreaterThan(dayMinute(at("2026-11-04", "23:40")));
    expect(minuteClock(clockMinute("07:05")!)).toBe("07:05");
  });
  it("pairs starts and ends, and a lone end uses the usual length", () => {
    const e: Entry[] = [
      { kind: "step", id: "bath", edge: "start", time: at("2026-11-04", "08:00") },
      { kind: "step", id: "bath", edge: "end", time: at("2026-11-04", "08:14") },
      { kind: "step", id: "breakfast", edge: "end", time: at("2026-11-04", "09:00") },
    ];
    const d = buildDays(e, C, new Map([["breakfast", 25]])).get("2026-11-04")!;
    expect(d.steps.get("bath")).toEqual([{ start: at("2026-11-04", "08:00"), end: at("2026-11-04", "08:14") }]);
    expect(d.steps.get("breakfast")![0].start).toBe(at("2026-11-04", "08:35"));
  });
  it("the same moment from the health app and by hand counts once", () => {
    const t = at("2026-11-04", "07:00");
    const d = buildDays([{ kind: "step", id: "wake", edge: "point", time: t }, { kind: "step", id: "wake", edge: "point", time: t + 20_000, health: true }], C);
    expect(d.get("2026-11-04")!.steps.get("wake")!.length).toBe(1);
  });
});

/** `n` past days with the same morning: wake 7:00, brush 7:05–7:09, bath 7:30–7:45, breakfast 8:00–8:20. */
function history(n: number, end = "2026-11-04") {
  const lines: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(`${end}T12:00:00`);
    d.setDate(d.getDate() - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const ts = (hhmm: string) => formatTimestamp(new Date(at(day, hhmm)));
    lines.push(`${ts("07:00")} Wake up`, `${ts("07:05")} Brush start`, `${ts("07:09")} Brush end`, `${ts("07:30")} Bath start`, `${ts("07:45")} Bath end`, `${ts("08:00")} Breakfast start`, `${ts("08:20")} Breakfast end`, `${ts("23:30")} Sleep`);
  }
  return lines;
}

describe("stats, filling in and the plan", () => {
  const lines = history(6);
  const today = "2026-11-04";
  const base = buildDays(entriesIn(doc(lines), C), C);
  const stats = routineStats(base, C, null, today);

  it("knows the usual times and lengths", () => {
    expect(stats.get("bath")).toMatchObject({ minutes: 15, often: 1, days: 6 });
    expect(minuteClock(stats.get("bath")!.start!)).toBe("07:30");
    expect(minuteClock(stats.get("sleep")!.start!)).toBe("23:30");
    expect(stats.get("exercise")!.often).toBe(0);
  });

  it("fills brush and bath before a logged breakfast, never exercise", () => {
    const todayLines = [`${formatTimestamp(new Date(at(today, "07:10")))} Wake up`, `${formatTimestamp(new Date(at(today, "08:30")))} Breakfast`];
    const days = buildDays(entriesIn(doc(todayLines), C), C, usualMinutes(stats));
    const filled = fillDay(days.get(today), C, stats);
    const bath = filled.get("bath")![0];
    const brush = filled.get("brush")![0];
    expect(bath.estimated).toBe(true);
    expect(bath.end).toBe(at(today, "08:10")); // breakfast 08:10–08:30 (its usual 20m)
    expect(bath.end - bath.start).toBe(15 * 60_000);
    expect(brush.end).toBe(bath.start);
    expect(filled.has("exercise")).toBe(false);
  });

  it("squeezes guesses to fit after the step before", () => {
    const todayLines = [`${formatTimestamp(new Date(at(today, "07:50")))} Wake up`, `${formatTimestamp(new Date(at(today, "08:00")))} Breakfast start`];
    const days = buildDays(entriesIn(doc(todayLines), C), C, usualMinutes(stats));
    const filled = fillDay(days.get(today), C, stats);
    expect(filled.get("brush")![0].start).toBeGreaterThanOrEqual(at(today, "07:50"));
    expect(filled.get("bath")![0].end).toBe(at(today, "08:00"));
  });

  it("plans the rest at the usual times, never before now", () => {
    const todayLines = [`${formatTimestamp(new Date(at(today, "07:00")))} Wake up`];
    const filled = fillDay(buildDays(entriesIn(doc(todayLines), C), C).get(today), C, stats);
    const plan = planRest(filled, C, stats, today, at(today, "07:20"));
    expect(plan.map((p) => p.id)).toEqual(["brush", "bath", "breakfast", "sleep"]);
    expect(plan[0].start).toBe(at(today, "07:20"));
    expect(plan[1].start).toBe(at(today, "07:30"));
    expect(plan[3].start).toBe(at(today, "23:30"));
  });

  it("free time and deviation", () => {
    const filled = fillDay(base.get("2026-11-03"), C, stats);
    // 07:00 → 23:30 is 990 min; steps take 4 + 15 + 20.
    expect(freeMinutes("2026-11-03", filled, C, stats)).toBe(990 - 39);
    expect(deviation(C.steps[3], stats.get("bath"), at(today, "07:50"))).toBe(20);
    expect(deviation({ ...C.steps[3], ideal: "08:00" }, stats.get("bath"), at(today, "07:50"))).toBe(-10);
  });

  it("phases compare their own usual days", () => {
    const c: RoutineConfig = { ...C, phases: [{ id: "v", name: "Vacation", start: "2026-11-01" }] };
    const sums = phaseSummaries(buildDays(entriesIn(doc(lines), c), c), c, today);
    expect(sums.map((s) => [s.name, s.days])).toEqual([["Before", 3], ["Vacation", 3]]);
    expect(minuteClock(sums[1].wake!)).toBe("07:00");
  });

  it("the rest check stays quiet on an ordinary fortnight", () => {
    const many = buildDays(entriesIn(doc(history(25)), C), C);
    expect(restCheck(many, C, routineStats(many, C, null, today), today)).toBeNull();
  });
});

describe("habit trends", () => {
  it("counts, buckets, smooths and predicts", () => {
    const t = (d: string, h: string) => ({ kind: "habit" as const, id: "water", edge: "point" as const, time: at(d, h) });
    const days = buildDays([t("2026-11-02", "09:00"), t("2026-11-02", "12:00"), t("2026-11-04", "10:00")], C);
    expect(habitSeries(days, "water", "2026-11-01", "2026-11-04")).toEqual([0, 2, 0, 1]);
    expect(buckets([1, 2, 3, 4, 5], 2)).toEqual([3, 7, 5]);
    expect(smooth([0, 0, 9, 0, 0], 1).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(smooth([1, 2, 3, 4, 5, 6, 7, 8], 2.5).every(Number.isFinite)).toBe(true);
    expect(predict([1, 2, 3, 4], 2).map((x) => Math.round(x))).toEqual([5, 6]);
    expect(predict([4, 3, 2, 1, 0], 3).every((x) => x >= 0)).toBe(true);
    expect(weekStart("2026-11-04")).toBe("2026-11-02");
  });
});

describe("open and ticked-off steps", () => {
  it("a start left open on an older day is a moment, today it runs until now", () => {
    const old = buildDays([{ kind: "step", id: "work", edge: "start", time: at("2026-11-02", "09:00") }], C, new Map(), at("2026-11-04", "10:00"));
    const s = old.get("2026-11-02")!.steps.get("work")![0];
    expect(s.end).toBe(s.start);
    const now = at("2026-11-04", "10:00");
    const t = buildDays([{ kind: "step", id: "work", edge: "start", time: at("2026-11-04", "09:00") }], C, new Map(), now);
    expect(t.get("2026-11-04")!.steps.get("work")![0]).toMatchObject({ end: now, open: true });
  });
  it("a ticked-off step isn't 'going on'", () => {
    const d = buildDays([{ kind: "step", id: "breakfast", edge: "end", time: at("2026-11-04", "09:00") }], C, new Map([["breakfast", 20]]));
    expect(d.get("2026-11-04")!.steps.get("breakfast")![0]).toEqual({ start: at("2026-11-04", "08:40"), end: at("2026-11-04", "09:00"), startGuessed: true });
  });
});

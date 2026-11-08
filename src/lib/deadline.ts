import { atDayMinute, habitual, phaseOf, type RoutineConfig, type RoutineDayLog, type StepStats } from "./routine";
import { addDays } from "./timestamp";
import { skyAt } from "./sky";

/**
 * The deadline bar: one bar per calendar day (midnight to midnight) from when it was made to the
 * deadline, so the note can carry text between the days. Routine blocks (meals, bath, sleep) can be
 * laid behind it from the current phase's usual times or from one chosen day, and what's left
 * between them is free time, labelled with how long it is.
 */
export interface Busy {
  start: number;
  end: number;
  icon: string;
  label: string;
  sleep?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Local midnight of a "YYYY-MM-DD" day. */
export function midnight(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Calendar days a timeline covers, from the day of `from` to the day of `to`. */
export function daysBetween(from: string, to: string, max = 62): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Where the routine comes from: off, the phase's usual day, or one real day copied. */
export type Layer = "off" | "avg" | `day:${string}`;

/**
 * The routine blocks of one routine day (04:00 → 04:00), as times. Work/study steps are left out:
 * they're what the free time is for. Sleep runs from the usual (or that day's) sleep time to the
 * next morning's wake-up.
 */
export function routineBusy(day: string, layer: Layer, config: RoutineConfig, stats: Map<string, StepStats>, days: Map<string, RoutineDayLog>): Busy[] {
  if (layer === "off") return [];
  const out: Busy[] = [];
  const sleepStep = config.steps.find((s) => s.health === "sleep");
  const wakeStep = config.steps.find((s) => s.health === "wake");
  const usualWake = wakeStep ? stats.get(wakeStep.id)?.start ?? null : null;
  if (layer === "avg") {
    for (const s of config.steps) {
      const st = stats.get(s.id);
      if (!s.span || s.work || !habitual(st) || st!.start === null) continue;
      const start = atDayMinute(day, st!.start);
      out.push({ start, end: start + Math.max(5, st!.minutes) * MIN, icon: s.icon, label: s.label });
    }
    const sl = sleepStep ? stats.get(sleepStep.id)?.start ?? null : null;
    if (sleepStep && sl !== null && usualWake !== null) {
      out.push({ start: atDayMinute(day, sl), end: atDayMinute(addDays(day, 1), usualWake), icon: sleepStep.icon, label: sleepStep.label, sleep: true });
    }
  } else {
    const from = layer.slice(4);
    const shift = atDayMinute(day, 0) - atDayMinute(from, 0);
    const log = days.get(from);
    for (const s of config.steps) {
      if (s.work) continue;
      for (const x of log?.steps.get(s.id) ?? []) {
        if (s.span && x.end > x.start) out.push({ start: x.start + shift, end: x.end + shift, icon: s.icon, label: s.label });
      }
    }
    const sleeps = sleepStep ? log?.steps.get(sleepStep.id) : undefined;
    const slept = sleeps?.[sleeps.length - 1];
    if (sleepStep && slept) {
      const next = wakeStep ? days.get(addDays(from, 1))?.steps.get(wakeStep.id)?.[0] : undefined;
      const end = next ? next.start + shift : usualWake !== null ? atDayMinute(addDays(day, 1), usualWake) : slept.start + shift + 8 * HOUR;
      if (end > slept.start + shift) out.push({ start: slept.start + shift, end, icon: sleepStep.icon, label: sleepStep.label, sleep: true });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Routine blocks touching one calendar day (from its own routine day and the one before), clipped to it. */
export function busyOn(day: string, layer: Layer, config: RoutineConfig, stats: Map<string, StepStats>, days: Map<string, RoutineDayLog>): Busy[] {
  const t0 = midnight(day);
  const t1 = t0 + DAY;
  return [...routineBusy(addDays(day, -1), layer, config, stats, days), ...routineBusy(day, layer, config, stats, days)]
    .filter((b) => b.end > t0 && b.start < t1)
    .map((b) => ({ ...b, start: Math.max(b.start, t0), end: Math.min(b.end, t1) }))
    .sort((a, b) => a.start - b.start);
}

/** The part of a day the bar shows: all of it, or (zoomed to waking hours) from the morning's wake-up to the night's sleep. */
export function shownRange(day: string, busy: Busy[], awake: boolean): [number, number] {
  const t0 = midnight(day);
  const t1 = t0 + DAY;
  if (!awake) return [t0, t1];
  const noon = t0 + 12 * HOUR;
  const morning = busy.filter((b) => b.sleep && b.start <= t0 + 60_000 && b.end < noon).map((b) => b.end);
  const night = busy.filter((b) => b.sleep && b.end >= t1 - 60_000 && b.start > noon).map((b) => b.start);
  const a = morning.length ? Math.max(...morning) : t0 + 6 * HOUR;
  const z = night.length ? Math.min(...night) : t1;
  return a < z ? [a, z] : [t0, t1];
}

export interface Free {
  start: number;
  end: number;
}

/** Free stretches inside [from, to) between the busy blocks, at least `min` long. */
export function freeGaps(from: number, to: number, busy: Busy[], min = 15 * MIN): Free[] {
  const out: Free[] = [];
  let cursor = from;
  for (const b of [...busy].sort((x, y) => x.start - y.start)) {
    if (b.end <= cursor) continue;
    if (b.start >= to) break;
    if (b.start - cursor >= min) out.push({ start: cursor, end: Math.min(b.start, to) });
    cursor = Math.max(cursor, b.end);
  }
  if (to - cursor >= min) out.push({ start: cursor, end: to });
  return out;
}

/** The sky's colours across [from, to) as a CSS gradient, like the timestamp chips. */
export function skyGradient(from: number, to: number, steps = 24): string {
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    stops.push(`${skyAt(t).bg} ${((i / steps) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** Past days of a phase that have a routine log, newest first: the "copy this day" choices. */
export function templateDays(config: RoutineConfig, days: Map<string, RoutineDayLog>, today: string, limit = 21): string[] {
  const phase = phaseOf(today, config.phases);
  return [...days.values()]
    .filter((d) => d.day < today && d.steps.size >= 2 && phaseOf(d.day, config.phases)?.id === phase?.id)
    .map((d) => d.day)
    .sort()
    .reverse()
    .slice(0, limit);
}

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Mon 9 Nov" and whether it's a weekend. */
export function dayLabel(day: string): { text: string; weekend: boolean } {
  const d = new Date(midnight(day));
  const w = d.getDay();
  return { text: `${WEEK[w]} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`, weekend: w === 0 || w === 6 };
}

/** "14:30" */
export const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

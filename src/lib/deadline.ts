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

/** What kind of time a plan is: its colour and icon on the bars. */
export type PlanKind = "focus" | "admin" | "break" | "other";
export const PLAN_KINDS: { id: PlanKind; icon: string; label: string; color: string }[] = [
  { id: "focus", icon: "🎯", label: "Focus", color: "#5b6cf0" },
  { id: "admin", icon: "📋", label: "Admin", color: "#14a38b" },
  { id: "break", icon: "☕", label: "Break", color: "#e0913a" },
  { id: "other", icon: "•", label: "Other", color: "#8a8fa3" },
];

/** Something planned into free time (by hand, or by the AI: `ai` is its name). */
export interface Plan {
  id: string;
  start: number;
  end: number;
  text: string;
  ai?: string;
  done?: boolean;
  kind?: PlanKind;
  note?: string;
  /** The deadline step this plan works on. */
  step?: string;
  /** Focus timer sessions actually spent on it. */
  actual?: { start: number; end: number }[];
}

/** One step of a deadline (with its estimate); `at` makes it a milestone flag on the bars. */
export interface Step {
  id: string;
  text: string;
  mins: number;
  done?: boolean;
  at?: number;
}

export type Repeat = "" | "weekly" | "monthly";

/** Deadline-wide settings kept on every bar of it. */
export interface DeadlineInfo {
  tid: string;
  title: string;
  endAt: number;
  emoji: string;
  color: string;
  notes: string;
  /** Work it needs in total (minutes); 0 = add up the steps. */
  need: number;
  steps: Step[];
  status: "" | "done" | "archived";
  /** Minutes before each plan to remind (0 = off); due alerts a day and an hour before. */
  remind: number;
  dueAlerts: boolean;
  /** Drag snap in minutes. */
  snap: number;
  repeat: Repeat;
}

export const DEADLINE_COLORS = ["#5b6cf0", "#8a5cff", "#e0568f", "#e0913a", "#14a38b", "#3b9be0", "#6b7280"];

export function infoOf(a: Record<string, unknown>): DeadlineInfo {
  return {
    tid: String(a.tid ?? ""),
    title: String(a.title ?? ""),
    endAt: Number(a.endAt) || 0,
    emoji: String(a.emoji || "⏳"),
    color: String(a.color || DEADLINE_COLORS[0]),
    notes: String(a.notes ?? ""),
    need: Number(a.need) || 0,
    steps: Array.isArray(a.steps) ? (a.steps as Step[]) : [],
    status: (a.status as DeadlineInfo["status"]) || "",
    remind: a.remind === undefined || a.remind === null ? 10 : Number(a.remind) || 0,
    dueAlerts: a.dueAlerts !== false,
    snap: Number(a.snap) || 5,
    repeat: (a.repeat as Repeat) || "",
  };
}

/** Minutes of work a deadline needs: its own figure, or its steps added up. */
export const needMins = (d: Pick<DeadlineInfo, "need" | "steps">) => d.need || d.steps.reduce((s, x) => s + (x.mins || 0), 0);

/** Time spent on a plan: its focus sessions, or (ticked done without a timer) its planned length. */
export const spentOn = (p: Plan) => (p.actual?.length ? p.actual.reduce((s, a) => s + Math.max(0, a.end - a.start), 0) : p.done ? p.end - p.start : 0);

export interface Progress {
  done: number;
  planned: number;
  need: number;
  /** Free time still open up to the deadline (not planned yet). */
  free: number;
  status: "none" | "done" | "ok" | "tight" | "behind";
  /** Work still needing a place (need - done - planned), never below 0. */
  short: number;
}

/** Done / planned / needed, and whether that still fits in the free time left. */
export function progressOf(plans: Plan[], need: number, now: number, free: number, finished = false): Progress {
  const done = plans.reduce((s, p) => s + spentOn(p), 0);
  const planned = plans.filter((p) => !p.done && p.end > now).reduce((s, p) => s + p.end - Math.max(p.start, now), 0);
  const short = Math.max(0, need - done - planned);
  let status: Progress["status"] = "none";
  if (finished || (need > 0 && done >= need)) status = "done";
  else if (need > 0) status = short === 0 ? "ok" : short <= free * 0.6 ? "tight" : "behind";
  return { done, planned, need, free, status, short };
}

/** Plans whose time passed without being ticked done. */
export const missedPlans = (plans: Plan[], now: number) => plans.filter((p) => !p.done && p.end <= now && !p.actual?.length);

/** Rounds a time to the snap grid, or onto a nearby edge (routine, other plans, now) within `tol`. */
export function snapTime(t: number, gridMins: number, edges: number[], tol: number): { t: number; edge: boolean } {
  let best: number | null = null;
  for (const e of edges) if (Math.abs(e - t) <= tol && (best === null || Math.abs(e - t) < Math.abs(best - t))) best = e;
  if (best !== null) return { t: best, edge: true };
  const g = Math.max(1, gridMins) * MIN;
  return { t: Math.round(t / g) * g, edge: false };
}

/** The first free stretch at least `len` long between `from` and `until`. */
export function nextFreeSlot(len: number, from: number, until: number, taken: { start: number; end: number }[]): number | null {
  const g = freeGaps(from, until, taken.map((x) => ({ ...x, icon: "", label: "" })), len);
  return g.length ? g[0].start : null;
}

/** After `id` moved, plans it now overlaps (and the ones they then overlap) are pushed later, keeping their order. */
export function pushLater(plans: Plan[], id: string): Plan[] {
  const out = plans.map((p) => ({ ...p })).sort((a, b) => a.start - b.start);
  const moved = out.find((p) => p.id === id);
  if (!moved) return out;
  let edge = moved.end;
  for (const p of out) {
    if (p.id === id || p.done || p.end <= moved.start) continue;
    if (p.start < edge) {
      const len = p.end - p.start;
      p.start = edge;
      p.end = edge + len;
    }
    edge = Math.max(edge, p.end);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Does any other plan overlap these? */
export const overlaps = (plans: Plan[], ids: Set<string>) => plans.some((p) => !ids.has(p.id) && plans.some((q) => ids.has(q.id) && q.start < p.end && p.start < q.end));

/** One plan cut in two at `at` (both halves keep the rest of it). */
export function splitPlan(p: Plan, at: number, newId: string): [Plan, Plan] | null {
  if (at <= p.start || at >= p.end) return null;
  return [{ ...p, end: at, actual: undefined }, { ...p, id: newId, start: at, actual: undefined, done: false }];
}

/** "1h 30", "90", "1:30", "45m", "2h" → minutes. */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const colon = /^(\d+):(\d{1,2})$/.exec(t);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const hm = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m?(?:in(?:utes?)?)?)?$/.exec(t);
  if (hm && (hm[1] || hm[2])) {
    const h = hm[1] ? Number(hm[1]) : 0;
    const m = hm[2] ? Number(hm[2]) : 0;
    // A bare number after hours is minutes; a bare number alone is minutes.
    return Math.round(h * 60 + m);
  }
  return null;
}

/** Plan vs actual for each step (and the plans not on a step), for the review after the deadline. */
export function reviewOf(steps: Step[], plans: Plan[]) {
  const rows = steps.map((s) => {
    const mine = plans.filter((p) => p.step === s.id);
    return { id: s.id, text: s.text, estimate: s.mins * MIN, planned: mine.reduce((t, p) => t + p.end - p.start, 0), spent: mine.reduce((t, p) => t + spentOn(p), 0), done: !!s.done };
  });
  const loose = plans.filter((p) => !p.step || !steps.some((s) => s.id === p.step));
  if (loose.length) rows.push({ id: "", text: "Other plans", estimate: 0, planned: loose.reduce((t, p) => t + p.end - p.start, 0), spent: loose.reduce((t, p) => t + spentOn(p), 0), done: false });
  return rows;
}

/** Ready-made deadlines: steps with estimates. */
export interface DeadlineTemplate {
  name: string;
  emoji: string;
  color: string;
  steps: { text: string; mins: number }[];
  prefs?: string;
}
export const BUILT_IN_TEMPLATES: DeadlineTemplate[] = [
  { name: "Exam prep", emoji: "📚", color: "#8a5cff", steps: [{ text: "List the syllabus topics", mins: 30 }, { text: "Read and make notes", mins: 360 }, { text: "Solve past papers", mins: 240 }, { text: "Revise weak topics", mins: 180 }, { text: "Final quick revision", mins: 60 }], prefs: "Hard topics in the morning, 10 min break every hour." },
  { name: "Project", emoji: "🚀", color: "#3b9be0", steps: [{ text: "Plan and outline", mins: 60 }, { text: "Build the main part", mins: 480 }, { text: "Test and fix", mins: 180 }, { text: "Polish and present", mins: 120 }] },
  { name: "Assignment", emoji: "📝", color: "#e0568f", steps: [{ text: "Read the brief", mins: 20 }, { text: "Research", mins: 120 }, { text: "Write the draft", mins: 180 }, { text: "Check and submit", mins: 45 }] },
  { name: "Weekly report", emoji: "📊", color: "#14a38b", steps: [{ text: "Collect numbers", mins: 30 }, { text: "Write it up", mins: 45 }, { text: "Send", mins: 10 }] },
];

/** The same moment one repeat later. */
export function nextRepeat(t: number, repeat: Repeat): number {
  const d = new Date(t);
  if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
  return d.getTime();
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

/** A stretch of time in hours and minutes ("26h", "3h 20m", "45m"): free time is never shown in days. */
export function hm(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Free stretches across several days (each day's routine from `busyFor`, plus `taken`), between `from` and `until`. */
export function freeAcross(days: string[], busyFor: (day: string) => Busy[], taken: { start: number; end: number }[], from: number, until: number, min = 15 * MIN): Free[] {
  const out: Free[] = [];
  const t = taken.map((x) => ({ start: x.start, end: x.end, icon: "", label: "" }));
  for (const d of days) {
    const t0 = midnight(d);
    const a = Math.max(t0, from);
    const z = Math.min(t0 + DAY, until);
    if (z <= a) continue;
    out.push(...freeGaps(a, z, [...busyFor(d), ...t.filter((x) => x.end > t0 && x.start < t0 + DAY)], min));
  }
  return out;
}

/** The first free start where `len` fits, at or after `after`. */
export function firstFit(gaps: Free[], len: number, after: number): number | null {
  for (const g of gaps) {
    const s = Math.max(g.start, after);
    if (g.end - s >= len) return s;
  }
  return null;
}

/** "3h free tomorrow evening" for the biggest free stretch ahead. */
export function freeHint(gaps: Free[], now: number): string {
  const big = [...gaps].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (!big) return "no free time left";
  const today = midnight(dayKeyOf(now));
  const d = Math.round((midnight(dayKeyOf(big.start)) - today) / DAY);
  const when = d === 0 ? "today" : d === 1 ? "tomorrow" : dayLabel(dayKeyOf(big.start)).text;
  const h = new Date(big.start).getHours();
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return `${hm(big.end - big.start)} free ${when} ${part}`;
}

const dayKeyOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

import type { JSONContent } from "@tiptap/react";
import { addDays, dayKey, formatTimestamp } from "./timestamp";
import { stampsIn } from "./timeGaps";

/**
 * Daily routine and habits. Every tap writes one timestamped line into the day's note (in a
 * [[Routine]] box), e.g. "4,November,2026 Wednesday (07:12:03) 🪥 Brush start", so the log is
 * ordinary journal text: it syncs and merges like any writing, shows in the 🕒 Time outline, and a
 * line typed by hand counts the same. Everything else here (usual times, durations, the filled-in
 * steps that weren't logged, today's plan, phases, trends) is worked out from those lines and is
 * never written back.
 */

export interface RoutineStep {
  id: string;
  label: string;
  icon: string;
  /** Has a start and an end (Bath start / end); otherwise it's one moment (Wake up). */
  span: boolean;
  /** Filled from the phone's health app (Samsung Health through Health Connect). */
  health?: "exercise" | "sleep" | "wake";
  /** Counts as work or study (for the gentle "you've been working a lot" check). */
  work?: boolean;
  /** Minutes it takes before there's any history of it. */
  minutes?: number;
  /** An ideal start time ("07:00"); without one, the usual time from the logs is the guide. */
  ideal?: string;
  /** Earlier names, so lines written before a rename still count. */
  aliases?: string[];
}

export interface Habit {
  id: string;
  label: string;
  icon: string;
  aliases?: string[];
}

/** A stretch of life with its own rhythm (vacation, college term…), from its start day on. */
export interface Phase {
  id: string;
  name: string;
  start: string;
}

export interface RoutineConfig {
  steps: RoutineStep[];
  habits: Habit[];
  phases: Phase[];
  /** Gentle notifications when a step usually starts (off unless turned on). */
  nudges?: boolean;
  /** Quiet: no "later than usual", no comparisons. Just the log and the plan. */
  quiet?: boolean;
  /** Read exercise and sleep from the health app (phone). */
  health?: boolean;
}

export const DEFAULT_ROUTINE: RoutineConfig = {
  steps: [
    { id: "wake", label: "Wake up", icon: "☀️", span: false, health: "wake" },
    { id: "brush", label: "Brush", icon: "🪥", span: true, minutes: 4 },
    { id: "exercise", label: "Exercise", icon: "🏋️", span: true, health: "exercise", minutes: 40 },
    { id: "bath", label: "Bath", icon: "🛁", span: true, minutes: 15 },
    { id: "breakfast", label: "Breakfast", icon: "🍳", span: true, minutes: 20 },
    { id: "work", label: "Work / study", icon: "💻", span: true, work: true, minutes: 180 },
    { id: "lunch", label: "Lunch", icon: "🍛", span: true, minutes: 30 },
    { id: "dinner", label: "Dinner", icon: "🍲", span: true, minutes: 30 },
    { id: "sleep", label: "Sleep", icon: "😴", span: false, health: "sleep" },
  ],
  habits: [
    { id: "water", label: "Water", icon: "💧" },
    { id: "coffee", label: "Coffee", icon: "☕" },
    { id: "stretch", label: "Stretch", icon: "🧘" },
  ],
  phases: [],
};

/** A routine day runs from 04:00 to 04:00, so going to bed after midnight belongs to the evening before. */
export const DAY_START_HOUR = 4;
const DAY_MS = 86_400_000;
const MIN = 60_000;

/** The routine day a moment belongs to (before 04:00 counts as the day before). */
export function routineDay(t: number): string {
  return dayKey(new Date(t - DAY_START_HOUR * 3_600_000));
}

/** Minutes after 04:00 of its routine day (0…1439), so 23:40 and 00:30 stay in order. */
export function dayMinute(t: number): number {
  const d = new Date(t);
  return (d.getHours() * 60 + d.getMinutes() - DAY_START_HOUR * 60 + 1440) % 1440;
}

/** The moment `minute` (after 04:00) on routine day `day`. */
export function atDayMinute(day: string, minute: number): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, DAY_START_HOUR, 0, 0).getTime() + Math.round(minute) * MIN;
}

/** "07:05" for a minute after 04:00. */
export function minuteClock(minute: number): string {
  const m = Math.round(((minute + DAY_START_HOUR * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "07:00" → minutes after 04:00, or null. */
export function clockMinute(hhmm: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return (Number(m[1]) * 60 + Number(m[2]) - DAY_START_HOUR * 60 + 1440) % 1440;
}

// ───── Reading the lines ─────

export type Edge = "start" | "end" | "point";
export interface Entry {
  kind: "step" | "habit";
  id: string;
  edge: Edge;
  time: number;
  /** Came from the health app (the line says so). */
  health?: boolean;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const START_WORDS = new Set(["start", "starts", "started", "begin", "began", "starting"]);
const END_WORDS = new Set(["end", "ends", "ended", "finish", "finished", "done", "stop", "stopped", "over"]);

/**
 * What a timestamp's line says, if it's a routine step or habit: "🪥 Brush start", "Finish
 * breakfast", "Wake up". Anything more after it ("Lunch with Sam was fun") is journal writing, not
 * a log, except a bracket note like "(Samsung Health)".
 */
export function matchEntry(label: string, config: RoutineConfig): Omit<Entry, "time"> | null {
  const bracket = /\(([^)]*)\)\s*$/.exec(label);
  const health = !!bracket && /health/i.test(bracket[1]);
  let text = norm(bracket ? label.slice(0, bracket.index) : label);
  if (!text) return null;
  let edge: Edge | null = null;
  const first = text.split(" ")[0];
  if (START_WORDS.has(first) || END_WORDS.has(first)) {
    edge = START_WORDS.has(first) ? "start" : "end";
    text = text.slice(first.length).trim();
  }
  const candidates: { kind: "step" | "habit"; id: string; name: string; span: boolean }[] = [];
  for (const s of config.steps) for (const n of [s.label, ...(s.aliases ?? [])]) candidates.push({ kind: "step", id: s.id, name: norm(n), span: s.span });
  for (const h of config.habits) for (const n of [h.label, ...(h.aliases ?? [])]) candidates.push({ kind: "habit", id: h.id, name: norm(n), span: false });
  // Longest name first: "work study" before "work".
  candidates.sort((a, b) => b.name.length - a.name.length);
  for (const c of candidates) {
    if (!c.name || !(text === c.name || text.startsWith(c.name + " "))) continue;
    const rest = text.slice(c.name.length).trim();
    if (rest) {
      if (edge || !(START_WORDS.has(rest) || END_WORDS.has(rest))) continue;
      edge = START_WORDS.has(rest) ? "start" : "end";
    }
    if (!c.span) return { kind: c.kind, id: c.id, edge: "point", ...(health ? { health } : {}) };
    // Ticking a step off without saying start or end: it's done now.
    return { kind: c.kind, id: c.id, edge: edge ?? "end", ...(health ? { health } : {}) };
  }
  return null;
}

/** Text lines of a note (paragraphs and headings, nested ones too). */
function textLines(doc: JSONContent | null | undefined): string[] {
  const lines: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "paragraph" || n.type === "heading") {
      lines.push((n.content ?? []).map((c) => c.text ?? "").join(""));
      return;
    }
    if (n.type === "codeBlock") return;
    n.content?.forEach(walk);
  };
  walk(doc ?? { type: "doc" });
  return lines;
}

/** Every routine and habit log line in a note. */
export function entriesIn(doc: JSONContent | null | undefined, config: RoutineConfig): Entry[] {
  const out: Entry[] = [];
  for (const s of stampsIn(textLines(doc).map((text) => ({ pos: 0, text })))) {
    const m = matchEntry(s.label, config);
    if (m) out.push({ ...m, time: s.time });
  }
  return out;
}

/** The line a tap writes: "<timestamp> 🪥 Brush start". */
export function logLine(at: Date, item: { icon: string; label: string }, edge: Edge, note?: string): string {
  const what = edge === "point" ? item.label : `${item.label} ${edge}`;
  return `${formatTimestamp(at)} ${item.icon} ${what}${note ? ` (${note})` : ""}`;
}

export const BOX_TITLE = "[[Routine]]";
const isBoxTitle = (b: JSONContent, box: string) => b.type === "paragraph" && (b.content ?? []).map((c) => c.text ?? "").join("").trim().toLowerCase() === box.toLowerCase();

/** The note with `line` added at the end of its [[Routine]] box (the box is made at the end if there's none). */
export function withLogLine(doc: JSONContent | null | undefined, line: string, box = BOX_TITLE): JSONContent {
  const content = [...(doc?.content ?? [])];
  const at = content.findIndex((b) => isBoxTitle(b, box));
  if (at >= 0) {
    const base = Number(content[at].attrs?.indent ?? 0);
    let end = at + 1;
    while (end < content.length && Number(content[end].attrs?.indent ?? 0) > base) end++;
    content.splice(end, 0, { type: "paragraph", attrs: { indent: base + 1 }, content: [{ type: "text", text: line }] });
    return { type: "doc", content };
  }
  const last = content[content.length - 1];
  if (last?.type === "paragraph" && !last.content?.length && !last.attrs?.info) content.pop();
  content.push({ type: "paragraph", content: [{ type: "text", text: box }] }, { type: "paragraph", attrs: { indent: 1 }, content: [{ type: "text", text: line }] });
  return { type: "doc", content };
}

// ───── Days and sessions ─────

export interface Session {
  start: number;
  end: number;
  /** No end logged yet (still going) or no start logged (worked out from the usual length). */
  open?: boolean;
  /** Only its end was logged ("Breakfast" ticked off): the start is its usual length before. */
  startGuessed?: boolean;
  /** Worked out, not logged. */
  estimated?: boolean;
  health?: boolean;
}

export interface RoutineDayLog {
  day: string;
  /** Step id → its sessions that day, in time order. */
  steps: Map<string, Session[]>;
  /** Habit id → times logged. */
  habits: Map<string, number[]>;
}

/** Groups log entries by routine day and pairs starts with ends. `durations` fills a lone end's start. */
export function buildDays(entries: Entry[], config: RoutineConfig, durations: Map<string, number> = new Map(), now = Date.now()): Map<string, RoutineDayLog> {
  const days = new Map<string, RoutineDayLog>();
  const sorted = [...entries].sort((a, b) => a.time - b.time);
  // Health lines and hand-logged lines for the same moment count once.
  const seen = new Set<string>();
  const get = (day: string) => {
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, steps: new Map(), habits: new Map() }));
    return d;
  };
  const span = new Map(config.steps.map((s) => [s.id, s.span]));
  const openAt = new Map<string, { day: string; s: Session }>();
  for (const e of sorted) {
    const k = `${e.kind}|${e.id}|${e.edge}|${Math.floor(e.time / MIN)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (e.kind === "habit") {
      const d = get(routineDay(e.time));
      d.habits.set(e.id, [...(d.habits.get(e.id) ?? []), e.time]);
      continue;
    }
    if (!span.has(e.id)) continue;
    if (e.edge === "point" || !span.get(e.id)) {
      const d = get(routineDay(e.time));
      d.steps.set(e.id, [...(d.steps.get(e.id) ?? []), { start: e.time, end: e.time, ...(e.health ? { health: true } : {}) }]);
      continue;
    }
    if (e.edge === "start") {
      const s: Session = { start: e.time, end: e.time, open: true, ...(e.health ? { health: true } : {}) };
      const day = routineDay(e.time);
      const d = get(day);
      d.steps.set(e.id, [...(d.steps.get(e.id) ?? []), s]);
      openAt.set(e.id, { day, s });
      continue;
    }
    // An end: closes the open start (if it's under 16 hours old), else stands alone.
    const open = openAt.get(e.id);
    if (open && e.time - open.s.start < 16 * 3_600_000) {
      open.s.end = e.time;
      delete open.s.open;
      openAt.delete(e.id);
      continue;
    }
    const dur = (durations.get(e.id) ?? config.steps.find((s) => s.id === e.id)?.minutes ?? 0) * MIN;
    const d = get(routineDay(e.time));
    d.steps.set(e.id, [...(d.steps.get(e.id) ?? []), { start: e.time - dur, end: e.time, startGuessed: true, ...(e.health ? { health: true } : {}) }]);
  }
  // A start still open: it runs until now (today), or is left as a moment (an older day).
  const today = routineDay(now);
  for (const { day, s } of openAt.values()) s.end = day === today ? Math.max(s.start, Math.min(now, s.start + 16 * 3_600_000)) : s.start;
  const workout = new Set(config.steps.filter((s) => s.health === "exercise").map((s) => s.id));
  for (const d of days.values())
    for (const [id, list] of d.steps) {
      list.sort((a, b) => a.start - b.start);
      // One workout with short rests is one session, also for parts written before this was merged.
      if (workout.has(id)) d.steps.set(id, mergeSessions(list));
    }
  return days;
}

/** Rests up to this long inside a workout don't split it (the health app records ~2 min breaks as new sessions). */
export const WORKOUT_GAP_MS = 3 * MIN;

/**
 * Joins sessions that overlap or follow each other within `gap` into one, in time order (a workout
 * with short rests between sets). The joined one keeps the earliest start and the latest end.
 */
export function mergeSessions<T extends { start: number; end: number; open?: boolean; startGuessed?: boolean }>(list: T[], gap = WORKOUT_GAP_MS): T[] {
  const out: T[] = [];
  for (const s of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= gap) {
      const merged = { ...last, end: Math.max(last.end, s.end) };
      if (s.open) merged.open = true;
      else if (s.end >= last.end) delete merged.open;
      // A guessed start that falls inside a real one isn't a guess any more.
      if (!last.startGuessed) delete merged.startGuessed;
      out[out.length - 1] = merged;
    } else out.push({ ...s });
  }
  return out;
}

// ───── Phases and stats ─────

/** The phase a day falls in (the latest one that started on or before it), or null. */
export function phaseOf(day: string, phases: Phase[]): Phase | null {
  let best: Phase | null = null;
  for (const p of phases) if (p.start <= day && (!best || p.start > best.start)) best = p;
  return best;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface StepStats {
  /** Usual start, minutes after 04:00 (this phase). */
  start: number | null;
  /** Usual length in minutes (all phases: a bath takes as long in a vacation as in term). */
  minutes: number;
  /** Share of logged days it happened on (this phase). */
  often: number;
  /** Days with any log (this phase). */
  days: number;
}

/**
 * Usual time and length of each step. Times come from the days of `phase` (all days when it has
 * fewer than 3 logged); lengths from every day, because how long brushing takes doesn't change
 * with the timetable. Only days before `before` count (today isn't its own history).
 */
export function routineStats(days: Map<string, RoutineDayLog>, config: RoutineConfig, phase: Phase | null, before: string): Map<string, StepStats> {
  const past = [...days.values()].filter((d) => d.day < before && d.steps.size > 0);
  const own = past.filter((d) => phaseOf(d.day, config.phases)?.id === phase?.id);
  const pool = own.length >= 3 ? own : past;
  const out = new Map<string, StepStats>();
  for (const s of config.steps) {
    const lens: number[] = [];
    for (const d of past) for (const x of d.steps.get(s.id) ?? []) if (!x.open && !x.startGuessed && !x.estimated && x.end > x.start && x.end - x.start < 16 * 3_600_000) lens.push((x.end - x.start) / MIN);
    const starts: number[] = [];
    let hit = 0;
    for (const d of pool) {
      const first = (d.steps.get(s.id) ?? []).find((x) => !x.estimated);
      if (!first) continue;
      hit++;
      starts.push(dayMinute(first.start));
    }
    out.set(s.id, {
      start: median(starts),
      minutes: s.span ? Math.round(median(lens.slice(-60)) ?? s.minutes ?? 15) : 0,
      often: pool.length ? hit / pool.length : 0,
      days: pool.length,
    });
  }
  return out;
}

/** Usual lengths only (for pairing a lone "end" line). */
export function usualMinutes(stats: Map<string, StepStats>): Map<string, number> {
  return new Map([...stats].map(([id, s]) => [id, s.minutes]));
}

/** A step is part of the routine when it happened on at least half the logged days (with 3+ days known). */
export const habitual = (s: StepStats | undefined) => !!s && s.days >= 3 && s.often >= 0.5;

/**
 * The day's log with the steps that weren't logged filled in: when a later step is logged (say
 * Breakfast) and earlier everyday steps (Brush, Bath) aren't, they're placed right before it with
 * their usual lengths, squeezed to fit after the step logged before them. Health steps and steps
 * that aren't everyday are never guessed.
 */
export function fillDay(log: RoutineDayLog | undefined, config: RoutineConfig, stats: Map<string, StepStats>): Map<string, Session[]> {
  const steps = new Map<string, Session[]>();
  for (const [id, list] of log?.steps ?? []) steps.set(id, list.map((s) => ({ ...s })));
  const order = config.steps;
  const anchors = order.map((s, i) => ({ i, first: steps.get(s.id)?.[0] })).filter((a) => a.first);
  const canGuess = (i: number) => {
    const s = order[i];
    return !steps.has(s.id) && s.health !== "exercise" && s.health !== "sleep" && habitual(stats.get(s.id));
  };
  for (let a = 0; a < anchors.length; a++) {
    const later = anchors[a];
    const prev = a > 0 ? anchors[a - 1] : null;
    const lo = prev ? Math.max(...(steps.get(order[prev.i].id) ?? []).filter((s) => s.start <= later.first!.start).map((s) => s.end), -Infinity) : -Infinity;
    if (prev && !(lo <= later.first!.start)) continue;
    const gap: number[] = [];
    for (let i = (prev?.i ?? -1) + 1; i < later.i; i++) if (canGuess(i)) gap.push(i);
    if (!gap.length) continue;
    const lens = gap.map((i) => (order[i].span ? stats.get(order[i].id)!.minutes : 0) * MIN);
    const total = lens.reduce((x, y) => x + y, 0);
    const room = lo === -Infinity ? total : later.first!.start - lo;
    const k = total > room && total > 0 ? Math.max(0, room) / total : 1;
    let cursor = later.first!.start;
    for (let g = gap.length - 1; g >= 0; g--) {
      const end = cursor;
      const start = end - lens[g] * k;
      steps.set(order[gap[g]].id, [{ start, end, estimated: true }]);
      cursor = start;
    }
  }
  return steps;
}

export interface PlanItem {
  id: string;
  start: number;
  end: number;
}

/**
 * The rest of today, from your own averages: the steps after the last one done, each at its usual
 * time (or the ideal time set for it), never before now and never on top of the step before.
 * Steps whose usual time passed more than two hours ago are taken as skipped today.
 */
export function planRest(filled: Map<string, Session[]>, config: RoutineConfig, stats: Map<string, StepStats>, day: string, now: number): PlanItem[] {
  const order = config.steps;
  let last = -1;
  let cursor = now;
  order.forEach((s, i) => {
    const list = filled.get(s.id);
    if (list?.length) {
      last = i;
      cursor = Math.max(cursor, ...list.map((x) => x.end));
    }
  });
  const out: PlanItem[] = [];
  for (let i = last + 1; i < order.length; i++) {
    const s = order[i];
    const st = stats.get(s.id);
    const usual = clockMinute(s.ideal) ?? (habitual(st) ? st!.start : null);
    if (usual === null) continue;
    const at = atDayMinute(day, usual);
    const len = (s.span ? st?.minutes ?? s.minutes ?? 15 : 0) * MIN;
    if (at + len + 2 * 3_600_000 < now) continue;
    const start = Math.max(at, cursor);
    out.push({ id: s.id, start, end: start + len });
    cursor = start + len;
  }
  return out;
}

/** Minutes a step started away from its ideal (or usual) time; positive = later. */
export function deviation(step: RoutineStep, stats: StepStats | undefined, start: number): number | null {
  const ref = clockMinute(step.ideal) ?? stats?.start ?? null;
  if (ref === null) return null;
  let d = dayMinute(start) - ref;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return Math.round(d);
}

/**
 * Free time on a day: awake time (wake-up to going to bed) not taken by any step. With `now` it's
 * what's left from now to the planned bedtime, after the planned steps.
 */
export function freeMinutes(day: string, steps: Map<string, Session[]>, config: RoutineConfig, stats: Map<string, StepStats>, plan: PlanItem[] = [], now?: number): number | null {
  const wakeStep = config.steps.find((s) => s.health === "wake")?.id ?? config.steps[0]?.id;
  const sleepStep = config.steps.find((s) => s.health === "sleep")?.id ?? config.steps[config.steps.length - 1]?.id;
  const usualAt = (id: string | undefined) => {
    const m = id ? stats.get(id)?.start : null;
    return m === null || m === undefined ? null : atDayMinute(day, m);
  };
  const wake = (wakeStep ? steps.get(wakeStep)?.[0]?.start : undefined) ?? usualAt(wakeStep);
  const sleep = (sleepStep ? steps.get(sleepStep)?.[0]?.start : undefined) ?? plan.find((p) => p.id === sleepStep)?.start ?? usualAt(sleepStep);
  if (wake === null || sleep === null || sleep <= wake) return null;
  const from = now === undefined ? wake : Math.max(wake, now);
  if (from >= sleep) return 0;
  // Busy stretches between `from` and bedtime, merged so overlaps count once.
  const busy: [number, number][] = [];
  for (const [id, list] of steps) if (id !== wakeStep && id !== sleepStep) for (const s of list) busy.push([s.start, s.end]);
  for (const p of plan) if (p.id !== sleepStep) busy.push([p.start, p.end]);
  busy.sort((a, b) => a[0] - b[0]);
  let taken = 0;
  let edge = from;
  for (const [a, b] of busy) {
    const s = Math.max(a, edge);
    const e = Math.min(b, sleep);
    if (e > s) {
      taken += e - s;
      edge = e;
    }
  }
  return Math.max(0, Math.round((sleep - from - taken) / MIN));
}

/** Minutes of work/study on a day. */
export function workMinutes(steps: Map<string, Session[]>, config: RoutineConfig): number {
  let ms = 0;
  for (const s of config.steps) if (s.work) for (const x of steps.get(s.id) ?? []) ms += x.end - x.start;
  return Math.round(ms / MIN);
}

/**
 * A gentle check against burning out: over the last two weeks, clearly more work and clearly less
 * free time than this phase's own normal. Returns a kind note to show, or null. Never a score.
 */
export function restCheck(days: Map<string, RoutineDayLog>, config: RoutineConfig, stats: Map<string, StepStats>, today: string): string | null {
  const phase = phaseOf(today, config.phases);
  const logged = [...days.values()].filter((d) => d.day < today && d.steps.size > 0 && phaseOf(d.day, config.phases)?.id === phase?.id);
  const recentFrom = addDays(today, -14);
  const recent = logged.filter((d) => d.day >= recentFrom);
  const before = logged.filter((d) => d.day < recentFrom);
  if (recent.length < 8 || before.length < 7) return null;
  const work = (list: RoutineDayLog[]) => median(list.map((d) => workMinutes(fillDay(d, config, stats), config)));
  const free = (list: RoutineDayLog[]) => median(list.map((d) => freeMinutes(d.day, fillDay(d, config, stats), config, stats)).filter((x): x is number => x !== null));
  const [w1, w0, f1, f0] = [work(recent), work(before), free(recent), free(before)];
  if (w1 === null || w0 === null || f1 === null || f0 === null || w0 < 30) return null;
  if (w1 > w0 * 1.3 && f1 < f0 * 0.75)
    return "These two weeks have held a lot more work and less free time than your usual. Nothing needs fixing: maybe leave some time today with nothing planned in it.";
  return null;
}

// ───── Habits: counts, a smooth curve and where it's heading ─────

/** Times a habit was logged on each day from `from` to `to` (inclusive), oldest first. */
export function habitSeries(days: Map<string, RoutineDayLog>, habitId: string, from: string, to: string): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(days.get(d)?.habits.get(habitId)?.length ?? 0);
  return out;
}

/** Sums of `size` values each (the last one may be partial). */
export function buckets(series: number[], size: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < series.length; i += size) out.push(series.slice(i, i + size).reduce((a, b) => a + b, 0));
  return out;
}

/** A smooth curve through the counts: a Gaussian-weighted average around each point. */
export function smooth(values: number[], width = 2): number[] {
  if (width <= 0) return [...values];
  return values.map((_, i) => {
    let sum = 0;
    let w = 0;
    const reach = Math.ceil(width * 3);
    for (let j = Math.max(0, i - reach); j <= Math.min(values.length - 1, i + reach); j++) {
      const k = Math.exp(-((i - j) ** 2) / (2 * width * width));
      sum += values[j] * k;
      w += k;
    }
    return w ? sum / w : 0;
  });
}

/**
 * Where the counts are heading: a straight line fitted to the recent values (newer ones weigh
 * more), carried `ahead` steps on. Never below zero.
 */
export function predict(values: number[], ahead: number): number[] {
  const n = values.length;
  if (n === 0) return Array(ahead).fill(0);
  if (n === 1) return Array(ahead).fill(values[0]);
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  values.forEach((y, x) => {
    const w = 0.5 + x / (n - 1);
    sw += w;
    sx += w * x;
    sy += w * y;
    sxx += w * x * x;
    sxy += w * x * y;
  });
  const den = sw * sxx - sx * sx;
  const slope = den ? (sw * sxy - sx * sy) / den : 0;
  const icept = (sy - slope * sx) / sw;
  return Array.from({ length: ahead }, (_, k) => Math.max(0, icept + slope * (n + k)));
}

/** Monday of the week `day` is in. */
export function weekStart(day: string): string {
  const wd = new Date(`${day}T12:00:00`).getDay();
  return addDays(day, -((wd + 6) % 7));
}

/** Days between two YYYY-MM-DD keys. */
export function dayGap(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / DAY_MS);
}

// ───── Phases side by side ─────

export interface PhaseSummary {
  phase: Phase | null;
  name: string;
  days: number;
  /** Each everyday step at its usual time, for the day bar. */
  blocks: { id: string; start: number; minutes: number }[];
  wake: number | null;
  sleep: number | null;
  work: number | null;
  free: number | null;
}

/** Each phase's usual day: when things happen, work and free time (medians of its logged days). */
export function phaseSummaries(days: Map<string, RoutineDayLog>, config: RoutineConfig, today: string): PhaseSummary[] {
  const list: (Phase | null)[] = [...config.phases].sort((a, b) => a.start.localeCompare(b.start));
  const firstStart = list[0] ? (list[0] as Phase).start : null;
  const all = [...days.values()].filter((d) => d.day <= today && d.steps.size);
  // Days before the first phase make up an unnamed "Before" phase.
  if (!firstStart || all.some((d) => d.day < firstStart)) list.unshift(null);
  return list.map((phase) => {
    const own = all.filter((d) => (phase ? phaseOf(d.day, config.phases)?.id === phase.id : !firstStart || d.day < firstStart));
    const own3 = new Map(own.map((d) => [d.day, d]));
    const stats = routineStats(own3, { ...config, phases: [] }, null, addDays(today, 1));
    const blocks = config.steps
      .filter((s) => habitual(stats.get(s.id)) && stats.get(s.id)!.start !== null)
      .map((s) => ({ id: s.id, start: stats.get(s.id)!.start!, minutes: stats.get(s.id)!.minutes }));
    const wakeId = config.steps.find((s) => s.health === "wake")?.id;
    const sleepId = config.steps.find((s) => s.health === "sleep")?.id;
    const filled = own.map((d) => fillDay(d, config, stats));
    return {
      phase,
      name: phase?.name ?? (firstStart ? "Before" : "All days"),
      days: own.length,
      blocks,
      wake: wakeId ? stats.get(wakeId)?.start ?? null : null,
      sleep: sleepId ? stats.get(sleepId)?.start ?? null : null,
      work: median(filled.map((f) => workMinutes(f, config))),
      free: median(own.map((d, i) => freeMinutes(d.day, filled[i], config, stats)).filter((x): x is number => x !== null)),
    };
  });
}

/** "1h 20m" for minutes. */
export function minutesText(m: number): string {
  const a = Math.round(Math.abs(m));
  if (a < 60) return `${a}m`;
  return a % 60 ? `${Math.floor(a / 60)}h ${a % 60}m` : `${Math.floor(a / 60)}h`;
}

/** A short id for a new step, habit or phase. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Fills in anything an older saved config is missing. */
export function normalizeConfig(c: Partial<RoutineConfig> | null | undefined): RoutineConfig {
  return {
    ...DEFAULT_ROUTINE,
    ...(c ?? {}),
    steps: Array.isArray(c?.steps) ? c!.steps : DEFAULT_ROUTINE.steps,
    habits: Array.isArray(c?.habits) ? c!.habits : DEFAULT_ROUTINE.habits,
    phases: Array.isArray(c?.phases) ? c!.phases : [],
  };
}

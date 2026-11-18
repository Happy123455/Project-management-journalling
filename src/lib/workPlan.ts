/**
 * Work and break blocks for a task, in the free time between `start` and `end` around the day's
 * usual duties (meals, bath, gym… from the Routine). Pomodoro-like: `work` minutes, then a short
 * break, a longer one after every third block. A block never runs into a duty; a gap too short
 * for a useful block (under 20 minutes) is left free. Times are ms.
 */

export interface Busy {
  start: number;
  end: number;
  what: string;
}

export interface PlanBlock {
  kind: "work" | "break" | "duty";
  start: number;
  end: number;
  what?: string;
}

const MIN = 60_000;
const MIN_WORK = 20;

/** Rounds up to the next 5 minutes. */
const up5 = (t: number) => Math.ceil(t / (5 * MIN)) * 5 * MIN;

export function planBlocks(o: { start: number; end: number; busy: Busy[]; total?: number; work?: number; brk?: number; longBreak?: number }): { blocks: PlanBlock[]; workMinutes: number; short: boolean } {
  const work = Math.max(10, o.work ?? 50) * MIN;
  const brk = Math.max(0, o.brk ?? 10) * MIN;
  const long = Math.max(brk, (o.longBreak ?? 25) * MIN);
  const want = o.total ? o.total * MIN : Infinity;
  const busy = o.busy.filter((b) => b.end > o.start && b.start < o.end).sort((a, b) => a.start - b.start);
  const blocks: PlanBlock[] = [];
  let t = up5(o.start);
  let done = 0;
  let count = 0;
  const nextBusy = (at: number) => busy.find((b) => b.end > at);
  while (t < o.end && done < want) {
    const b = nextBusy(t);
    // Inside a duty: carry on after it.
    if (b && b.start <= t) {
      if (!blocks.some((x) => x.kind === "duty" && x.start === b.start)) blocks.push({ kind: "duty", start: b.start, end: b.end, what: b.what });
      t = up5(b.end);
      continue;
    }
    const limit = Math.min(o.end, b ? b.start : o.end);
    const len = Math.min(work, want - done, limit - t);
    if (len < MIN_WORK * MIN && len < want - done) {
      // Too short to be worth it: skip to after the next duty (or stop).
      if (!b || b.start >= o.end) break;
      t = b.start;
      continue;
    }
    blocks.push({ kind: "work", start: t, end: t + len });
    done += len;
    count++;
    t += len;
    if (done >= want || t >= o.end) break;
    const pause = count % 3 === 0 ? long : brk;
    // A duty that starts right away is the break.
    const nb = nextBusy(t);
    if (nb && nb.start - t < pause) continue;
    if (pause) blocks.push({ kind: "break", start: t, end: t + pause });
    t += pause;
  }
  return { blocks, workMinutes: Math.round(done / MIN), short: Number.isFinite(want) && done < want };
}

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

/** The lines written into the note: "⏰ 09:00 🔨 Essay · work 1 (50 min)", "⏰ 09:50 ☕ Break (10 min)". */
export function planLines(task: string, blocks: PlanBlock[]): string[] {
  let n = 0;
  return blocks.map((b) => {
    const mins = Math.round((b.end - b.start) / MIN);
    if (b.kind === "work") return `⏰ ${hhmm(b.start)} 🔨 ${task} · work ${++n} (${mins} min, till ${hhmm(b.end)})`;
    if (b.kind === "break") return `⏰ ${hhmm(b.start)} ☕ Break (${mins} min)`;
    return `${hhmm(b.start)}–${hhmm(b.end)} ${b.what ?? "Routine"} (usual)`;
  });
}

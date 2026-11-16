// Item 13: scheduled "▶ Do this" blocks. A block with a schedule runs on the device that set it
// (kept in this device's storage, so the Mac and the phone don't both run it). One timer waits for
// the next run (no polling); when the app opens or comes back, a run missed in the last 12 hours
// happens once. Before each run the block is read again from its note: deleted, unscheduled or
// changed blocks are followed.
import type { JSONContent } from "@tiptap/core";
import type { JournalStore } from "../store";
import { missedRun, nextRun, type Schedule } from "./schedule";

export interface RunRecord {
  at: number;
  ok: boolean;
  answer: string;
}

export interface Scheduled {
  bid: string;
  /** Where the block is: a day (YYYY-MM-DD) or a page title. */
  note: string;
  text: string;
  schedule: Schedule;
  /** When it was set or last ran (missed runs count from here). */
  since: number;
  runs: RunRecord[];
}

const KEY = "journal.assistant.schedules";
const DEVICE_KEY = "journal.assistant.device";
export const SCHEDULE_EVENT = "journal:assistant-schedules";
const CATCH_UP_MS = 12 * 3600_000;

/** This install's own id for schedules (a block remembers which device runs it). */
export function thisDevice(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `d${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "here";
  }
}

export function loadScheduled(): Record<string, Scheduled> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function save(all: Record<string, Scheduled>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage full or off: schedules last for this session.
  }
  window.dispatchEvent(new Event(SCHEDULE_EVENT));
}

/** The block's schedule is set here (or changed); null removes it. */
export function setScheduled(bid: string, entry: Omit<Scheduled, "since" | "runs" | "bid"> | null) {
  const all = loadScheduled();
  if (!entry) delete all[bid];
  else {
    const old = all[bid];
    const same = old && JSON.stringify(old.schedule) === JSON.stringify(entry.schedule);
    all[bid] = { bid, ...entry, since: same ? old.since : Date.now(), runs: old?.runs ?? [] };
  }
  save(all);
  replan();
}

export function recordRun(bid: string, run: RunRecord) {
  const all = loadScheduled();
  const e = all[bid];
  if (e) {
    e.runs = [run, ...e.runs].slice(0, 5);
    e.since = Math.max(e.since, run.at);
    if (e.schedule.repeat === "once") delete all[bid];
  }
  // Runs from ▶ Run (not scheduled) are kept too, for the block to show.
  else lastRuns.set(bid, [run, ...(lastRuns.get(bid) ?? [])].slice(0, 5));
  save(all);
}
const lastRuns = new Map<string, RunRecord[]>();
export const runsOf = (bid: string) => loadScheduled()[bid]?.runs ?? lastRuns.get(bid) ?? [];

/** The block in its note now, or null when it's gone. */
export async function findBlock(store: JournalStore, note: string, bid: string): Promise<JSONContent | null> {
  const page = /^\d{4}-\d{2}-\d{2}$/.test(note) ? await store.getDay(note) : await store.getPage(note);
  let found: JSONContent | null = null;
  const walk = (n: JSONContent) => {
    if (found) return;
    if (n.type === "doThis" && n.attrs?.bid === bid) found = n;
    else n.content?.forEach(walk);
  };
  if (page?.content) walk(page.content);
  return found;
}

let timer = 0;
let runner: ((e: Scheduled) => Promise<void>) | null = null;
let busy = false;

/** The soonest run of every schedule here, and the ones missed (to run now). */
export function plan(all: Scheduled[], now: number): { next: { e: Scheduled; at: number } | null; missed: Scheduled[] } {
  let next: { e: Scheduled; at: number } | null = null;
  const missed: Scheduled[] = [];
  for (const e of all) {
    const m = missedRun(e.schedule, new Date(e.since), new Date(now));
    if (m && now - m.getTime() < CATCH_UP_MS) missed.push(e);
    const n = nextRun(e.schedule, new Date(now));
    if (n && (!next || n.getTime() < next.at)) next = { e, at: n.getTime() };
  }
  return { next, missed };
}

function replan() {
  window.clearTimeout(timer);
  if (!runner) return;
  const now = Date.now();
  const { next, missed } = plan(Object.values(loadScheduled()), now);
  if (missed.length && !busy) {
    void runAll(missed);
    return;
  }
  // Long waits are cut into 6-hour pieces (timers drift while the device sleeps).
  if (next) timer = window.setTimeout(() => void runDue(), Math.min(next.at - now + 500, 6 * 3600_000));
}

async function runDue() {
  const now = Date.now();
  const due = Object.values(loadScheduled()).filter((e) => {
    const m = missedRun(e.schedule, new Date(e.since), new Date(now));
    return m && now - m.getTime() < CATCH_UP_MS;
  });
  if (due.length) await runAll(due);
  else replan();
}

async function runAll(list: Scheduled[]) {
  busy = true;
  try {
    for (const e of list) {
      // Marked first: a run that fails isn't tried again and again.
      const all = loadScheduled();
      if (all[e.bid]) {
        all[e.bid].since = Date.now();
        save(all);
      }
      await runner?.(e).catch(() => {});
    }
  } finally {
    busy = false;
    replan();
  }
}

/** Starts the schedules on this device: `run` does one (the App runs it through the assistant). */
export function startScheduler(run: (e: Scheduled) => Promise<void>): () => void {
  runner = run;
  const onVisible = () => document.visibilityState === "visible" && replan();
  document.addEventListener("visibilitychange", onVisible);
  replan();
  return () => {
    runner = null;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

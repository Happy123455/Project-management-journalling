import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import type { DayPage, JournalStore } from "../store";
import { addDays, dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { visibleInterval } from "../lib/power";
import { openDayEditor, insertLogLinePM, editLineJSON, editLinePM } from "../editor/noteEdit";
import type { LineEdit } from "../lib/reminders";
import {
  buildDays, entriesIn, fillDay, logLine, normalizeConfig, phaseOf, planRest, routineDay, routineStats, usualMinutes, withLogLine,
  type Edge, type Entry, type RoutineConfig, type RoutineDayLog, type Session, type StepStats, type PlanItem,
} from "../lib/routine";

export const ROUTINE_PAGE = "Routine";
/** Fired after a tap is written or the setup changes, so every view catches up. */
export const ROUTINE_EVENT = "journal:routine";
const HISTORY_DAYS = 400;

export async function loadConfig(store: JournalStore): Promise<RoutineConfig> {
  const page = await store.getPage(ROUTINE_PAGE);
  return normalizeConfig(page?.props.routine);
}

export async function saveConfig(store: JournalStore, config: RoutineConfig): Promise<void> {
  const page = await store.ensurePage(ROUTINE_PAGE);
  await store.setPageProps(page.id, { routine: config });
  window.dispatchEvent(new Event(ROUTINE_EVENT));
}

/** A day's note as it is right now: the open editor's text when it's showing, else the stored one. */
export async function currentDoc(store: JournalStore, day: string): Promise<JSONContent | null> {
  const editor = openDayEditor(day);
  if (editor) return editor.getJSON();
  return (await store.getDay(day))?.content ?? null;
}

/** Writes a change into a day's note: through its editor when it's open, else into the store. */
export async function changeDay(store: JournalStore, day: string, viaEditor: (e: NonNullable<ReturnType<typeof openDayEditor>>) => boolean, viaJson: (doc: JSONContent | null) => JSONContent | null, actor?: string): Promise<boolean> {
  const editor = openDayEditor(day);
  if (editor) return viaEditor(editor);
  const page = await store.getDay(day);
  const next = viaJson(page?.content ?? null);
  if (!next) return false;
  await store.saveDay({ day, content: next, plainText: docText(next), actor });
  return true;
}

/** Changes one line of a day's note (a reminder's time, ticking it off). */
export function editDayLine(store: JournalStore, day: string, line: string, edit: LineEdit): Promise<boolean> {
  return changeDay(store, day, (e) => editLinePM(e, line, edit), (doc) => (doc ? editLineJSON(doc, line, edit) : null));
}

/** One tap: a timestamped line in that day's [[Routine]] box. */
export async function writeLog(store: JournalStore, item: { icon: string; label: string }, edge: Edge, at = new Date(), opts: { note?: string; actor?: string } = {}) {
  const line = logLine(at, item, edge, opts.note);
  const day = dayKey(at);
  await changeDay(store, day, (e) => (insertLogLinePM(e, line), true), (doc) => withLogLine(doc, line), opts.actor);
  window.dispatchEvent(new CustomEvent(ROUTINE_EVENT, { detail: { day } }));
}

// Parsed notes are kept between loads: only days whose note changed are read again.
const parsed = new Map<string, { stamp: string; entries: Entry[]; key: string }>();

/**
 * Every routine and habit entry in the last ~400 days of notes. `recent`: only the last few days
 * are read again (after a tap or a sync); older days come from what was read before.
 */
export async function loadEntries(store: JournalStore, config: RoutineConfig, today: string, recent = false): Promise<Entry[]> {
  const fresh = addDays(today, -3);
  const from = addDays(today, -HISTORY_DAYS);
  const key = JSON.stringify([config.steps.map((s) => [s.id, s.label, s.span, s.aliases]), config.habits.map((h) => [h.id, h.label, h.aliases])]);
  const out: Entry[] = [];
  for (const day of await store.listDays()) {
    if (day < from) continue;
    const editor = openDayEditor(day);
    let page: DayPage | null = null;
    let doc: JSONContent | null;
    let stamp: string;
    if (editor) {
      doc = editor.getJSON();
      stamp = "";
    } else {
      const hit = parsed.get(day);
      if (recent && day < fresh && hit && hit.key === key) {
        out.push(...hit.entries);
        continue;
      }
      page = await store.getDay(day);
      stamp = page?.updatedAt ?? "";
      if (hit && hit.stamp === stamp && hit.key === key && stamp) {
        out.push(...hit.entries);
        continue;
      }
      doc = page?.content ?? null;
    }
    const entries = entriesIn(doc, config);
    if (stamp) parsed.set(day, { stamp, entries, key });
    out.push(...entries);
  }
  return out;
}

export interface RoutineView {
  config: RoutineConfig;
  days: Map<string, RoutineDayLog>;
  stats: Map<string, StepStats>;
  /** Today's steps: logged, plus the ones worked out (estimated). */
  filled: Map<string, Session[]>;
  plan: PlanItem[];
  /** The routine day (before 04:00 it's still yesterday's). */
  day: string;
  now: number;
}

/** Builds everything the views show from the setup and the entries. */
export function viewOf(config: RoutineConfig, entries: Entry[], now: number): RoutineView {
  const day = routineDay(now);
  const first = buildDays(entries, config, new Map(), now);
  const phase = phaseOf(day, config.phases);
  const stats0 = routineStats(first, config, phase, day);
  const days = buildDays(entries, config, usualMinutes(stats0), now);
  const stats = routineStats(days, config, phase, day);
  const filled = fillDay(days.get(day), config, stats);
  const plan = planRest(filled, config, stats, day, now);
  return { config, days, stats, filled, plan, day, now };
}

/** The routine, kept current: after taps, setup changes, sync, and once a minute while visible. */
export function useRoutine(store: JournalStore | null, active = true) {
  const [config, setConfig] = useState<RoutineConfig | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [now, setNow] = useState(Date.now());
  const reload = useCallback(async (recent = false) => {
    if (!store) return;
    const c = await loadConfig(store);
    setConfig(c);
    setEntries(await loadEntries(store, c, dayKey(new Date()), recent));
    setNow(Date.now());
  }, [store]);
  useEffect(() => {
    if (!active) return;
    void reload();
    let t: number | undefined;
    // A tap through an open editor reaches the note at once; give it a beat, then read.
    const soon = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void reload(true), 150);
    };
    window.addEventListener(ROUTINE_EVENT, soon);
    window.addEventListener("journal:synced", soon);
    const stop = visibleInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener(ROUTINE_EVENT, soon);
      window.removeEventListener("journal:synced", soon);
      stop();
    };
  }, [reload, active]);
  const view = useMemo(() => (config ? viewOf(config, entries, now) : null), [config, entries, now]);
  return { view, reload };
}

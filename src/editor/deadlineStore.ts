import { useSyncExternalStore } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { daysBetween, infoOf, type DeadlineInfo, type Layer, type Plan } from "../lib/deadline";
import { addDays, dayKey } from "../lib/timestamp";
import { changeDay } from "../routine/routineData";
import { showToast } from "../lib/toast";
import { randomLid } from "../sync/lineIds";
import { openDayEditor } from "./noteEdit";

/**
 * Deadlines as data: reading every deadline in the notes (for Timelines, the today card, plan
 * reminders, the watch and "free time against all deadlines"), and changing one, whether its note
 * is open (through the editor, so it's undoable and synced like typing) or not (the stored note).
 */

interface Row {
  day: string;
  comments: { at: number; text: string }[];
  plans: Plan[];
  /** What was written in the note after this day's bar, before the next one. */
  between: string[];
}
export interface Timeline {
  tid: string;
  title: string;
  endAt: number;
  layer: Layer;
  awake: boolean;
  /** The day note the bars are in. */
  note: string;
  rows: Row[];
  info: DeadlineInfo;
  prefs: string;
}

const textOf = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(textOf).join(n.type === "doc" ? "\n" : "");

/** Every deadline in one note, with the text written between its days. */
export function timelinesIn(doc: JSONContent | null | undefined, note: string): Timeline[] {
  const out = new Map<string, Timeline>();
  let last: Row | null = null;
  for (const n of doc?.content ?? []) {
    if (n.type === "deadlineBar" && n.attrs?.tid && n.attrs.day) {
      const a = n.attrs;
      const t: Timeline = out.get(a.tid) ?? { tid: a.tid, title: a.title || "Deadline", endAt: a.endAt, layer: a.layer ?? "avg", awake: !!a.awake, note, rows: [], info: infoOf(a), prefs: a.prefs ?? "" };
      if (a.first) Object.assign(t, { title: a.title || "Deadline", layer: a.layer ?? "avg", awake: !!a.awake, info: infoOf(a), prefs: a.prefs ?? "" });
      last = { day: a.day, comments: a.comments ?? [], plans: a.plans ?? [], between: [] };
      t.rows.push(last);
      out.set(a.tid, t);
      continue;
    }
    const text = textOf(n).trim();
    if (last && text) last.between.push(text);
  }
  // Text after the last day's bar isn't "between".
  for (const t of out.values()) {
    const end = t.rows[t.rows.length - 1];
    if (end) end.between = [];
  }
  return [...out.values()];
}

export const plansOf = (t: Timeline) => t.rows.flatMap((r) => r.plans);

/** Every deadline in the day notes of the last `back` days and all later ones, newest deadline first. */
export async function allTimelines(store: JournalStore, back = 120): Promise<Timeline[]> {
  const from = addDays(dayKey(new Date()), -back);
  const out: Timeline[] = [];
  for (const day of await store.listDays()) {
    if (day < from) continue;
    const editor = openDayEditor(day);
    const doc = editor ? editor.getJSON() : (await store.getDay(day))?.content;
    if (!JSON.stringify(doc ?? "").includes("deadlineBar")) continue;
    out.push(...timelinesIn(doc, day));
  }
  return out.sort((a, b) => b.endAt - a.endAt);
}

// ───────────── One shared, lazily refreshed list of every deadline ─────────────
let list: Timeline[] = [];
let storeRef: JournalStore | null = null;
const listeners = new Set<() => void>();
let timer = 0;
let reading = false;
let again = false;
async function refresh() {
  if (!storeRef) return;
  if (reading) return void (again = true);
  reading = true;
  try {
    list = await allTimelines(storeRef);
    listeners.forEach((f) => f());
  } finally {
    reading = false;
    if (again) {
      again = false;
      soon();
    }
  }
}
function soon(delay = 1200) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), delay);
}
let watching = false;
/** Starts keeping the list (App calls this once the store is open). */
export function watchDeadlines(store: JournalStore) {
  storeRef = store;
  if (!watching) {
    watching = true;
    const on = () => soon();
    window.addEventListener("journal:saved", on);
    window.addEventListener("journal:synced", on);
  }
  soon(300);
}
export const refreshDeadlines = () => soon(200);
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const useAllDeadlines = () => useSyncExternalStore(subscribe, () => list);
export const allDeadlinesNow = () => list;

// ───────────── Changing one deadline in an open editor ─────────────

export function barsOf(editor: Editor, tid: string) {
  const out: { pos: number; attrs: Record<string, unknown> }[] = [];
  editor.state.doc.forEach((n, pos) => void (n.type.name === "deadlineBar" && n.attrs.tid === tid && n.attrs.day && out.push({ pos, attrs: n.attrs })));
  return out;
}

/** Changes every bar of this deadline at once (its settings are shared). */
export function setAll(editor: Editor, tid: string, attrs: Record<string, unknown>) {
  const tr = editor.state.tr;
  editor.state.doc.forEach((n, pos) => void (n.type.name === "deadlineBar" && n.attrs.tid === tid && tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs })));
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** The bar's day something belongs on: the day it starts, or the nearest bar's day (never dropped). */
export function homeDay(days: string[], t: number): string {
  const d = dayKey(new Date(t));
  return d < days[0] ? days[0] : d > days[days.length - 1] ? days[days.length - 1] : days.includes(d) ? d : days.filter((k) => k <= d).pop()!;
}
const startOf = (x: { start?: number; at?: number }) => ("start" in x && x.start !== undefined ? x.start : x.at ?? 0);

/** Writes plans/comments back to the bars of their days (a plan belongs to the day it starts on). */
export function writeBack<T extends { start?: number; at?: number }>(editor: Editor, tid: string, field: "plans" | "comments", list: T[]) {
  const tr = editor.state.tr;
  const days = barsOf(editor, tid).map((b) => b.attrs.day as string);
  if (!days.length) return;
  editor.state.doc.forEach((n, pos) => {
    if (n.type.name !== "deadlineBar" || n.attrs.tid !== tid || !n.attrs.day) return;
    const mine = list.filter((x) => homeDay(days, startOf(x)) === n.attrs.day).sort((a, b) => startOf(a) - startOf(b));
    if (JSON.stringify(mine) !== JSON.stringify(n.attrs[field] ?? [])) tr.setNodeMarkup(pos, undefined, { ...n.attrs, [field]: mine });
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

export const plansIn = (editor: Editor, tid: string): Plan[] => barsOf(editor, tid).flatMap((b) => (b.attrs.plans as Plan[]) ?? []);
export const headOf = (editor: Editor, tid: string) => {
  const bars = barsOf(editor, tid);
  return (bars.find((b) => b.attrs.first) ?? bars[0])?.attrs ?? null;
};

/** Saves plans and offers to undo the change in a toast. */
export function savePlans(editor: Editor, tid: string, plans: Plan[], message?: string) {
  writeBack(editor, tid, "plans", plans);
  if (message) showToast(message, "info", { label: "Undo", run: () => editor.commands.undo() });
}

/** The bars a new deadline needs (one per day to the deadline, empty lines between). */
export function deadlineRows(endAt: number, title: string, extra: Record<string, unknown> = {}, from = dayKey(new Date())) {
  const tid = randomLid();
  const days = daysBetween(from, dayKey(new Date(endAt)));
  return days.flatMap((day, i) => {
    const bar = { type: "deadlineBar", attrs: { tid, day, endAt, title, layer: "avg", awake: false, comments: [], first: i === 0, show: days.length > 4 ? 4 : 0, ...extra } };
    return i < days.length - 1 ? [bar, { type: "paragraph" }] : [bar];
  });
}

/**
 * Moves a deadline's due time: bars are added for new days and removed for days past it (the text
 * written between them stays), plans and comments stay and go to the nearest day's bar.
 */
export function retime(editor: Editor, tid: string, endAt: number) {
  const bars = barsOf(editor, tid);
  if (!bars.length) return;
  const head = bars.find((b) => b.attrs.first) ?? bars[0];
  const plans = bars.flatMap((b) => (b.attrs.plans as Plan[]) ?? []);
  const comments = bars.flatMap((b) => (b.attrs.comments as { at: number }[]) ?? []);
  const firstDay = [bars[0].attrs.day as string, dayKey(new Date(endAt))].sort()[0];
  const days = daysBetween(firstDay, dayKey(new Date(endAt)), 400);
  const keep = new Set(days);
  const tr = editor.state.tr;
  // Remove days past the new due time (last first, so positions stay right).
  for (const b of [...bars].reverse()) {
    if (keep.has(b.attrs.day as string)) continue;
    const n = tr.doc.nodeAt(b.pos);
    if (n) tr.delete(b.pos, b.pos + n.nodeSize);
  }
  const type = editor.schema.nodes.deadlineBar;
  const para = editor.schema.nodes.paragraph;
  const base = { ...head.attrs, plans: [], comments: [], first: false };
  for (const day of days) {
    const have: { pos: number; day: string }[] = [];
    tr.doc.forEach((n, pos) => void (n.type.name === "deadlineBar" && n.attrs.tid === tid && have.push({ pos, day: n.attrs.day })));
    if (have.some((h) => h.day === day)) continue;
    const bar = type.create({ ...base, day });
    const after = have.find((h) => h.day > day);
    if (after) tr.insert(after.pos, [bar, para.create()]);
    else if (have.length) {
      const last = have[have.length - 1];
      const end = last.pos + tr.doc.nodeAt(last.pos)!.nodeSize;
      tr.insert(end, [para.create(), bar]);
    } else tr.insert(Math.min(head.pos, tr.doc.content.size), bar);
  }
  // Due time, which bar is first, and plans/comments on their days.
  const final: string[] = [];
  tr.doc.forEach((n) => void (n.type.name === "deadlineBar" && n.attrs.tid === tid && final.push(n.attrs.day)));
  const firstOf = final[0];
  tr.doc.forEach((n, pos) => {
    if (n.type.name !== "deadlineBar" || n.attrs.tid !== tid) return;
    const day = n.attrs.day as string;
    const settings = { ...head.attrs, plans: undefined, comments: undefined, day: undefined };
    tr.setNodeMarkup(pos, undefined, {
      ...n.attrs,
      ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)),
      day,
      endAt,
      first: day === firstOf,
      plans: plans.filter((p) => homeDay(final, p.start) === day),
      comments: comments.filter((c) => homeDay(final, c.at) === day),
    });
  });
  editor.view.dispatch(tr);
}

/** Removes every bar of a deadline (the writing around them stays); Undo in the toast brings it back. */
export function deleteDeadline(editor: Editor, tid: string, title: string) {
  const tr = editor.state.tr;
  for (const b of barsOf(editor, tid).reverse()) {
    const n = tr.doc.nodeAt(b.pos);
    if (n) tr.delete(b.pos, b.pos + n.nodeSize);
  }
  editor.view.dispatch(tr);
  showToast(`Deleted ⏳ ${title || "deadline"}`, "info", { label: "Undo", run: () => editor.commands.undo() });
}

// ───────────── Changing a deadline in any note (open or not) ─────────────

/** The editors showing each deadline right now (bars register themselves), for notes that aren't day notes. */
const live = new Map<string, Editor>();
export function registerDeadlineEditor(tid: string, editor: Editor) {
  live.set(tid, editor);
  return () => void (live.get(tid) === editor && live.delete(tid));
}

/** Changes a deadline's plans in its note, open or not (the today card, focus timer, watch). */
export function changePlansAnywhere(store: JournalStore, note: string, tid: string, change: (plans: Plan[]) => Plan[]): Promise<boolean> {
  const e = live.get(tid);
  if (e && !e.isDestroyed && barsOf(e, tid).length) {
    writeBack(e, tid, "plans", change(plansIn(e, tid)));
    refreshDeadlines();
    return Promise.resolve(true);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(note)) return Promise.resolve(false);
  return changeDay(
    store,
    note,
    (e) => {
      const before = plansIn(e, tid);
      const next = change(before);
      writeBack(e, tid, "plans", next);
      return true;
    },
    (doc) => {
      if (!doc?.content) return null;
      const bars = doc.content.filter((n) => n.type === "deadlineBar" && n.attrs?.tid === tid && n.attrs.day);
      if (!bars.length) return null;
      const days = bars.map((b) => b.attrs!.day as string);
      const next = change(bars.flatMap((b) => (b.attrs!.plans as Plan[]) ?? []));
      return {
        ...doc,
        content: doc.content.map((n) =>
          n.type === "deadlineBar" && n.attrs?.tid === tid && n.attrs.day ? { ...n, attrs: { ...n.attrs, plans: next.filter((p) => homeDay(days, p.start) === n.attrs!.day).sort((a, b) => a.start - b.start) } } : n,
        ),
      };
    },
  ).then((ok) => (refreshDeadlines(), ok));
}

// ───────────── Notifications for plans and due times ─────────────

/** Plan reminders (N minutes before each) and due alerts (a day and an hour before), for the phone's notifications. */
export function deadlineAlarms(list: Timeline[], now: number): { id: string; at: number; title: string; body: string; day: string }[] {
  const out: { id: string; at: number; title: string; body: string; day: string }[] = [];
  const week = now + 7 * 86_400_000;
  for (const t of list) {
    const i = t.info;
    if (i.status || t.endAt < now) continue;
    const name = `${i.emoji} ${t.title}`;
    if (i.remind > 0) {
      for (const p of plansOf(t)) {
        const at = p.start - i.remind * 60_000;
        if (p.done || at <= now || at > week) continue;
        out.push({ id: `dl|${t.tid}|${p.id}|${p.start}`, at, title: `${p.text || "Plan"} in ${i.remind} min`, body: `${name} · until ${new Date(p.end).toTimeString().slice(0, 5)}`, day: t.note });
      }
    }
    if (i.dueAlerts) {
      for (const [ahead, label] of [[86_400_000, "tomorrow"], [3_600_000, "in 1 hour"]] as const) {
        const at = t.endAt - ahead;
        if (at > now) out.push({ id: `dl|${t.tid}|due|${ahead}|${t.endAt}`, at, title: `${name} is due ${label}`, body: new Date(t.endAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), day: t.note });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 60);
}

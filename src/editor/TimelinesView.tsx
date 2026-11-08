import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { busyOn, clock, DAY, dayLabel, freeGaps, hm, midnight, shownRange, skyGradient, type Layer, type Plan } from "../lib/deadline";
import { timeLeft } from "../lib/reminders";
import { addDays, dayKey } from "../lib/timestamp";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { useNow, useRoutineShared } from "./deadlineBar";
import { openDayEditor } from "./noteEdit";

/** Opens ⏳ Timelines: every deadline bar made, or (with a tid) one of them side by side. */
export const TIMELINES_EVENT = "journal:timelines";
export const openTimelines = (detail?: { tid: string; note: string }) => window.dispatchEvent(new CustomEvent(TIMELINES_EVENT, { detail }));

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
}

const textOf = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(textOf).join(n.type === "doc" ? "\n" : "");

/** Every deadline in one note, with the text written between its days. */
export function timelinesIn(doc: JSONContent | null | undefined, note: string): Timeline[] {
  const out = new Map<string, Timeline>();
  let last: Row | null = null;
  for (const n of doc?.content ?? []) {
    if (n.type === "deadlineBar" && n.attrs?.tid && n.attrs.day) {
      const a = n.attrs;
      const t: Timeline = out.get(a.tid) ?? { tid: a.tid, title: a.title || "Deadline", endAt: a.endAt, layer: a.layer ?? "avg", awake: !!a.awake, note, rows: [] };
      if (a.first) Object.assign(t, { title: a.title || "Deadline", layer: a.layer ?? "avg", awake: !!a.awake });
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

/** Every deadline in the day notes of the last `back` days and all later ones, newest deadline first. */
async function allTimelines(store: JournalStore, back = 120): Promise<Timeline[]> {
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

/** One deadline, its days side by side as tall columns; ➜ marks where text was written between two days. */
function SideBySide({ t }: { t: Timeline }) {
  const view = useRoutineShared();
  const now = useNow();
  const [shown, setShown] = useState<number | null>(null);
  return (
    <div className="tl-side">
      <div className="tl-cols">
        {t.rows.map((r, i) => {
          const busy = view ? busyOn(r.day, t.layer, view.config, view.stats, view.days) : [];
          const [from, to] = shownRange(r.day, busy, t.awake);
          const span = to - from;
          const y = (x: number) => `${(((Math.min(Math.max(x, from), to) - from) / span) * 100).toFixed(2)}%`;
          const h = (s: number, e: number) => `${(((Math.min(e, to) - Math.max(s, from)) / span) * 100).toFixed(2)}%`;
          const plans = r.plans.filter((p) => p.end > midnight(r.day) && p.start < midnight(r.day) + DAY);
          const free = freeGaps(Math.max(from, now), Math.min(to, t.endAt), [...busy, ...plans.map((p) => ({ ...p, icon: "", label: p.text }))]);
          const label = dayLabel(r.day);
          return (
            <div key={r.day} className="tl-col-wrap">
              <div className={`tl-col${label.weekend ? " weekend" : ""}`}>
                <div className="tl-day">{label.text.split(" ")[0]}<small>{label.text.split(" ").slice(1).join(" ")}</small></div>
                <div className="tl-bar" style={{ background: skyGradient(from, to).replace("90deg", "180deg") }}>
                  {now > from && <div className="tl-past" style={{ height: h(from, now) }} />}
                  {t.endAt < to && <div className="tl-after" style={{ top: y(t.endAt), height: h(t.endAt, to) }} />}
                  {busy.map((b, k) => <div key={k} className={`tl-busy${b.sleep ? " sleep" : ""}`} style={{ top: y(b.start), height: h(b.start, b.end) }} title={`${b.label} ${clock(b.start)}–${clock(b.end)}`}>{b.icon}</div>)}
                  {plans.map((p) => <div key={p.id} className={`tl-plan${p.ai ? " ai" : ""}`} style={{ top: y(p.start), height: h(p.start, p.end) }}>{p.text}</div>)}
                  {free.filter((f) => (f.end - f.start) / span > 0.08).map((f, k) => <div key={k} className="tl-free" style={{ top: y(f.start), height: h(f.start, f.end) }}><span>{hm(f.end - f.start)}</span></div>)}
                  {r.comments.filter((c) => c.at >= from && c.at <= to).map((c, k) => <i key={k} className="tl-dot" style={{ top: y(c.at) }} title={`${clock(c.at)} ${c.text}`} />)}
                  {now >= from && now <= to && <i className="tl-now" style={{ top: y(now) }} />}
                </div>
              </div>
              {r.between.length > 0 && (
                <button type="button" className={`tl-arrow${shown === i ? " on" : ""}`} onClick={() => setShown(shown === i ? null : i)} title="Written between these days">➜</button>
              )}
            </div>
          );
        })}
      </div>
      {t.rows.map((r, i) => r.between.length > 0 && (
        <div key={r.day} className={`tl-between${shown === i ? " on" : ""}`} onClick={() => setShown(i)}>
          <b>➜ after {dayLabel(r.day).text}</b>
          {r.between.slice(0, shown === i ? 50 : 2).map((line, k) => <p key={k}>{line}</p>)}
        </div>
      ))}
    </div>
  );
}

/** ⏳ Timelines: every deadline in one place; tap one for its days side by side. */
export function TimelinesHost({ store, onOpenDay }: { store: JournalStore; onOpenDay: (day: string) => void }) {
  const [open, setOpen] = useState<{ tid?: string; note?: string } | null>(null);
  const [list, setList] = useState<Timeline[] | null>(null);
  const now = useNow();
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent).detail ?? {});
    window.addEventListener(TIMELINES_EVENT, on);
    return () => window.removeEventListener(TIMELINES_EVENT, on);
  }, []);
  useEffect(() => {
    if (!open) return;
    setList(null);
    void allTimelines(store).then(setList);
  }, [open, store]);
  const close = () => setOpen(null);
  useEscapeToClose(close, !!open);
  const picked = useMemo(() => list?.find((t) => t.tid === open?.tid) ?? null, [list, open]);
  if (!open) return null;
  return createPortal(
    <div className="settings-view tl-view" role="dialog" aria-label="Timelines">
      <header className="graph-bar">
        <button type="button" onClick={() => (picked ? setOpen({}) : close())} aria-label="Back">{picked ? "‹" : "✕"}</button>
        <h1 className="settings-title">⏳ {picked ? picked.title : "Timelines"}</h1>
        {picked && <button type="button" onClick={() => (close(), onOpenDay(picked.note))}>Open note</button>}
      </header>
      {!list ? (
        <p className="hint">Looking through your notes…</p>
      ) : picked ? (
        <>
          <p className="hint">{picked.endAt > now ? `${timeLeft(picked.endAt - now)} left` : "Due"} · due {new Date(picked.endAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
          <SideBySide t={picked} />
        </>
      ) : !list.length ? (
        <p className="hint">No deadlines yet. Type /deadline in a note to make one.</p>
      ) : (
        <ul className="tl-list">
          {list.map((t) => {
            const total = t.endAt - midnight(t.rows[0]?.day ?? dayKey(new Date()));
            const done = Math.min(1, Math.max(0, 1 - (t.endAt - now) / Math.max(1, total)));
            return (
              <li key={t.tid}>
                <button type="button" onClick={() => setOpen({ tid: t.tid, note: t.note })}>
                  <strong>{t.title}</strong>
                  <span>{t.endAt > now ? `${timeLeft(t.endAt - now)} left` : "past"} · {t.rows.length} day{t.rows.length === 1 ? "" : "s"} · in {dayLabel(t.note).text}</span>
                  <i className="tl-progress"><b style={{ width: `${done * 100}%` }} /></i>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    document.body,
  );
}

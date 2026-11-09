import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { busyOn, clock, DAY, dayLabel, freeGaps, hm, midnight, shownRange, skyGradient } from "../lib/deadline";
import { timeLeft } from "../lib/reminders";
import { addDays, dayKey } from "../lib/timestamp";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { useNow, useRoutineShared } from "./deadlineBar";
import { allTimelines, type Timeline } from "./deadlineStore";

/** Opens ⏳ Timelines: every deadline bar made, or (with a tid) one of them side by side. */
export const TIMELINES_EVENT = "journal:timelines";
export const openTimelines = (detail?: { tid: string; note: string }) => window.dispatchEvent(new CustomEvent(TIMELINES_EVENT, { detail }));

export { timelinesIn, type Timeline } from "./deadlineStore";

/** One deadline, its days side by side as tall columns; ➜ marks where text was written between two days. */
function SideBySide({ t }: { t: Timeline }) {
  const view = useRoutineShared();
  const now = useNow();
  const [shown, setShown] = useState<number | null>(null);
  // Free time only: everything else fades, the free stretches light up and pulse slowly a few times.
  const [freeOnly, setFreeOnly] = useState(false);
  return (
    <div className={`tl-side${freeOnly ? " free-only" : ""}`}>
      <button type="button" className={`tl-free-btn${freeOnly ? " on" : ""}`} onClick={() => setFreeOnly(!freeOnly)}>{freeOnly ? "Show everything" : "✨ Free time only"}</button>
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
                  {free.map((f, k) => <div key={`${k}${freeOnly}`} className="tl-free" style={{ top: y(f.start), height: h(f.start, f.end) }}>{(f.end - f.start) / span > 0.08 && <span>{hm(f.end - f.start)}</span>}</div>)}
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

/** Every open deadline on one set of day rows, each in its own colour: who claims which evening. */
function AllTogether({ list, now }: { list: Timeline[]; now: number }) {
  const live = list.filter((t) => !t.info.status && t.endAt > now);
  const today = dayKey(new Date(now));
  const last = live.reduce((m, t) => Math.max(m, t.endAt), now);
  const days: string[] = [];
  for (let d = today; midnight(d) <= last && days.length < 21; d = addDays(d, 1)) days.push(d);
  if (!live.length) return <p className="hint">No open deadlines.</p>;
  return (
    <div className="tl-all">
      <div className="tl-legend">{live.map((t) => <span key={t.tid} style={{ ["--c" as string]: t.info.color }}>{t.info.emoji} {t.title}</span>)}</div>
      {days.map((d) => {
        const a = midnight(d) + 6 * 3_600_000;
        const z = midnight(d) + DAY;
        const pct = (t: number) => `${(((Math.min(Math.max(t, a), z) - a) / (z - a)) * 100).toFixed(2)}%`;
        const l = dayLabel(d);
        return (
          <div key={d} className={`tl-all-row${l.weekend ? " weekend" : ""}`}>
            <b>{l.text}</b>
            <div className="tl-all-bar" style={{ background: skyGradient(a, z) }}>
              {live.flatMap((t) => t.rows.flatMap((r) => r.plans).filter((p) => p.end > a && p.start < z).map((p) => (
                <i key={p.id} className={`tl-all-plan${p.done ? " done" : ""}`} style={{ left: pct(p.start), width: `calc(${pct(p.end)} - ${pct(p.start)})`, ["--c" as string]: t.info.color }} title={`${t.title}: ${clock(p.start)}–${clock(p.end)} ${p.text}`} />
              )))}
              {live.filter((t) => t.endAt >= a && t.endAt <= z).map((t) => <span key={t.tid} className="tl-all-due" style={{ left: pct(t.endAt) }} title={`${t.title} due ${clock(t.endAt)}`}>{t.info.emoji}</span>)}
              {now >= a && now <= z && <i className="tl-now-v" style={{ left: pct(now) }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** ⏳ Timelines: every deadline in one place; tap one for its days side by side. */
export function TimelinesHost({ store, onOpenDay }: { store: JournalStore; onOpenDay: (day: string) => void }) {
  const [open, setOpen] = useState<{ tid?: string; note?: string } | null>(null);
  const [list, setList] = useState<Timeline[] | null>(null);
  const [together, setTogether] = useState(false);
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
      ) : together ? (
        <>
          <button type="button" className="tl-free-btn on tl-together-btn" onClick={() => setTogether(false)}>▦ All together</button>
          <AllTogether list={list} now={now} />
        </>
      ) : !list.length ? (
        <p className="hint">No deadlines yet. Type /deadline in a note to make one.</p>
      ) : (
        <ul className="tl-list">
          <li><button type="button" className="tl-together" onClick={() => setTogether(true)}><strong>▦ All together</strong><span>Every open deadline on the same days, each in its own colour</span></button></li>
          {list.map((t) => {
            const total = t.endAt - midnight(t.rows[0]?.day ?? dayKey(new Date()));
            const done = Math.min(1, Math.max(0, 1 - (t.endAt - now) / Math.max(1, total)));
            return (
              <li key={t.tid} className={t.info.status ? `is-${t.info.status}` : ""} style={{ ["--c" as string]: t.info.color }}>
                <button type="button" onClick={() => setOpen({ tid: t.tid, note: t.note })}>
                  <strong>{t.info.emoji} {t.title}{t.info.status === "done" ? " ✓" : ""}</strong>
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

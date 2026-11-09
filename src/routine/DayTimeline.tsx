import { useEffect, useRef } from "react";
import { deviation, fillDay, minutesText, type RoutineStep } from "../lib/routine";
import type { AgendaItem } from "../lib/reminders";
import { StepIcon } from "./StepIcon";
import type { RoutineView } from "./routineData";

const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

type Row =
  | { kind: "step"; at: number; end: number; step: RoutineStep; state: "done" | "open" | "estimated" | "planned"; health?: boolean; dev: number | null }
  | { kind: "habit"; at: number; icon: string; label: string }
  | { kind: "reminder"; at: number; item: AgendaItem }
  | { kind: "now"; at: number }
  | { kind: "free"; at: number; minutes: number };

/**
 * The day as one continuous line: logged steps, steps worked out from your usual lengths (≈),
 * the rest of today from your own averages (planned, faint), today's timed reminders, and a "now"
 * pointer. Gaps of 20 minutes or more show as free time.
 */
export function DayTimeline({ view, day, agenda = [], onReminder, scrollToNow }: { view: RoutineView; day: string; agenda?: AgendaItem[]; onReminder?: (item: AgendaItem) => void; scrollToNow?: boolean }) {
  const isToday = day === view.day;
  const { config, stats } = view;
  const filled = isToday ? view.filled : fillDay(view.days.get(day), config, stats);
  const rows: Row[] = [];
  for (const step of config.steps) {
    for (const s of filled.get(step.id) ?? []) {
      rows.push({ kind: "step", at: s.start, end: s.end, step, state: s.estimated ? "estimated" : s.open && isToday && s.end >= view.now - 60_000 ? "open" : "done", health: s.health, dev: config.quiet || s.estimated || s.startGuessed ? null : deviation(step, stats.get(step.id), s.start) });
    }
  }
  if (isToday) for (const p of view.plan) {
    const step = config.steps.find((s) => s.id === p.id);
    if (step) rows.push({ kind: "step", at: p.start, end: p.end, step, state: "planned", dev: null });
  }
  for (const h of config.habits) for (const t of view.days.get(day)?.habits.get(h.id) ?? []) rows.push({ kind: "habit", at: t, icon: h.icon, label: h.label });
  if (isToday) for (const a of agenda) rows.push({ kind: "reminder", at: a.at, item: a });
  rows.sort((a, b) => a.at - b.at);
  // Free stretches between busy ones (not counting moments like a habit tap or a reminder).
  const out: Row[] = [];
  let busyUntil: number | null = null;
  for (const r of rows) {
    if (r.kind === "step" && r.end > r.at) {
      if (busyUntil !== null && r.at - busyUntil >= 20 * 60_000) out.push({ kind: "free", at: busyUntil, minutes: (r.at - busyUntil) / 60_000 });
      busyUntil = Math.max(busyUntil ?? 0, r.end);
    } else if (r.kind === "step" && busyUntil === null) busyUntil = r.at;
    out.push(r);
  }
  if (isToday) {
    const i = out.findIndex((r) => r.at > view.now);
    out.splice(i < 0 ? out.length : i, 0, { kind: "now", at: view.now });
  }
  const nowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (scrollToNow) nowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isToday, scrollToNow]);
  if (out.length === (isToday ? 1 : 0)) return <p className="hint">Nothing on this day's timeline yet. Log a step or set a time on a reminder and it shows here.</p>;
  return (
    <ol className="day-timeline">
      {out.map((r, i) => {
        if (r.kind === "now")
          return (
            <li key={`now`} ref={nowRef} className="tl-now">
              <span className="tl-time">{clock(r.at)}</span>
              <span className="tl-now-line" aria-label="Now" />
              <span className="tl-label">now</span>
            </li>
          );
        if (r.kind === "free")
          return (
            <li key={`free-${i}`} className="tl-free">
              <span className="tl-time" />
              <span className="tl-label">free · {minutesText(r.minutes)}</span>
            </li>
          );
        if (r.kind === "habit")
          return (
            <li key={`h-${i}`} className="tl-habit">
              <span className="tl-time">{clock(r.at)}</span>
              <span className="tl-icon">{r.icon}</span>
              <span className="tl-label">{r.label}</span>
            </li>
          );
        if (r.kind === "reminder")
          return (
            <li key={`r-${r.item.id}`} className={r.item.done ? "tl-reminder done" : "tl-reminder"}>
              <span className="tl-time">{clock(r.at)}</span>
              <span className="tl-icon">🔔</span>
              <button type="button" className="tl-label" onClick={() => onReminder?.(r.item)}>{r.item.text}</button>
            </li>
          );
        const len = r.end - r.at;
        const est = r.state === "estimated" || r.state === "planned";
        return (
          <li key={`s-${r.step.id}-${r.at}`} className={`tl-step ${r.state}`}>
            <span className="tl-time">{est ? "≈" : ""}{clock(r.at)}</span>
            <span className="tl-icon"><StepIcon item={r.step} /></span>
            <span className="tl-label">
              {r.step.label}
              {r.state === "open" ? " · now" : len >= 60_000 ? ` · ${minutesText(len / 60_000)}` : ""}
              {r.state === "estimated" && <em> auto</em>}
              {r.state === "planned" && <em> usual</em>}
              {r.health && <em> ♥ health</em>}
            </span>
            {r.dev !== null && Math.abs(r.dev) >= 10 && <span className="tl-dev">{r.dev > 0 ? `${minutesText(r.dev)} later` : `${minutesText(r.dev)} earlier`}</span>}
          </li>
        );
      })}
    </ol>
  );
}

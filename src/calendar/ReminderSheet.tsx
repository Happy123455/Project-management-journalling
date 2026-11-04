import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { addDays, dayKey, dayTitle } from "../lib/timestamp";
import { stepDay } from "../lib/reminders";

/** The next Monday after `day` (a week starting fresh). */
function nextMonday(day: string): string {
  const wd = new Date(`${day}T12:00:00`).getDay();
  return addDays(day, ((8 - wd) % 7) || 7);
}

/**
 * Pick a day ahead: quick picks (tomorrow, in 3 days, next week, next month…) or any date.
 * Used to start a reminder and to move one to another day.
 */
export function DayPickerSheet({ title, from, onPick, onClose, withTime }: { title: string; from?: string; onPick: (day: string, time?: string) => void; onClose: () => void; withTime?: boolean }) {
  const today = dayKey(new Date());
  const base = from && from > today ? from : today;
  const [custom, setCustom] = useState(addDays(base, 1));
  // A time is optional: with one, the note starts with "⏰ 15:00" and rings then (else in the morning).
  const [time, setTime] = useState("");
  const pick = (day: string) => onPick(day, time || undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const picks: [string, string][] = [
    ["Tomorrow", addDays(base, 1)],
    ["In 3 days", addDays(base, 3)],
    ["Next week", nextMonday(base)],
    ["In 2 weeks", addDays(base, 14)],
    ["Next month", stepDay(base, "monthly")],
    ["In 3 months", stepDay(base, "monthly", 3)],
  ];
  const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return createPortal(
    <>
      <div className="search-backdrop" onClick={onClose} />
      <div className="confirm-card day-picker-sheet" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <div className="day-picks">
          {picks.map(([label, day]) => (
            <button key={label} type="button" onClick={() => pick(day)}>
              <strong>{label}</strong>
              <small>{short(day)}</small>
            </button>
          ))}
        </div>
        <label className="day-pick-custom">
          <span>📅 Any day</span>
          <input type="date" value={custom} min={addDays(today, 1)} onChange={(e) => setCustom(e.target.value)} />
          <button type="button" disabled={!custom || custom <= today} onClick={() => pick(custom)}>
            Go
          </button>
        </label>
        {custom > today && <p className="hint">{dayTitle(custom)}</p>}
        {withTime && (
          <label className="day-pick-custom">
            <span>⏰ At</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time (optional)" />
            {time ? <button type="button" onClick={() => setTime("")}>No time</button> : <small>optional</small>}
          </label>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

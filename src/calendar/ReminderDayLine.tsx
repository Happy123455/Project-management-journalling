import { useEffect, useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { reminderTimes, timeLeft } from "../lib/reminders";
import { skyAt } from "../lib/sky";
import { homeCoords, sunForDay } from "../lib/solar";
import { visibleInterval } from "../lib/power";

/** The time now, updated once a minute while the app is in sight. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => visibleInterval(() => setNow(Date.now()), 60_000), []);
  return now;
}

const MORNING_HOUR = 8;
const at = (day: string, h: number, m: number) => {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const pct = (h: number, m: number) => ((h * 60 + m) / 1440) * 100;

/**
 * A reminder's day as a line coloured like that day's sky where you are (night blue, dawn pink,
 * day, sunset, evening), with a point where each reminder falls, and how long is left until the next.
 * A reminder with no time written shows its morning nudge (08:00) as a hollow point.
 */
export function ReminderDayLine({ day, content }: { day: string; content: JSONContent | null | undefined }) {
  const now = useNow();
  const times = useMemo(() => reminderTimes(content), [content]);
  const points = times.length ? times : [{ hour: MORNING_HOUR, minute: 0, text: "" }];
  const timed = times.length > 0;
  // The sky through the day: a colour every half hour, from the real sun on that date.
  const sky = useMemo(() => {
    const coords = homeCoords();
    const stops: string[] = [];
    for (let i = 0; i <= 48; i++) stops.push(`${skyAt(at(day, 0, i * 30), coords).bg} ${(i / 48) * 100}%`);
    const sun = sunForDay(new Date(at(day, 12, 0)), coords);
    return { gradient: `linear-gradient(90deg, ${stops.join(", ")})`, sun };
  }, [day]);
  const next = points.find((p) => at(day, p.hour, p.minute) > now) ?? null;
  const nowPct = (() => {
    const start = at(day, 0, 0);
    const p = ((now - start) / 86_400_000) * 100;
    return p >= 0 && p <= 100 ? p : null;
  })();
  const sunPct = (t: number | null | undefined) => (t ? ((t - at(day, 0, 0)) / 86_400_000) * 100 : null);
  const rise = sunPct(sky.sun.rise);
  const set = sunPct(sky.sun.set);
  return (
    <span className="reminder-dayline">
      <span className="rdl-left">
        {next ? (
          <>
            ⏳ <b>{timeLeft(at(day, next.hour, next.minute) - now)}</b> left · {timed ? hhmm(next.hour, next.minute) : `morning nudge ${hhmm(MORNING_HOUR, 0)}`}
          </>
        ) : (
          <>✓ Passed</>
        )}
      </span>
      <span className="rdl-track" style={{ background: sky.gradient }} aria-hidden>
        {rise != null && <i className="rdl-sun" style={{ left: `${rise}%` }} title="Sunrise" />}
        {set != null && <i className="rdl-sun set" style={{ left: `${set}%` }} title="Sunset" />}
        {nowPct != null && <i className="rdl-now" style={{ left: `${nowPct}%` }} />}
        {points.map((p, i) => {
          const s = skyAt(at(day, p.hour, p.minute));
          return (
            <span key={i} className={`rdl-point${timed ? "" : " untimed"}${next === p ? " next" : ""}`} style={{ left: `${pct(p.hour, p.minute)}%` }} title={`${hhmm(p.hour, p.minute)} ${p.text}`}>
              <span className="rdl-dot" style={{ background: timed ? s.bg : "transparent" }} />
              <span className="rdl-time">{s.icon} {hhmm(p.hour, p.minute)}</span>
            </span>
          );
        })}
      </span>
      <span className="rdl-hours" aria-hidden>
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </span>
    </span>
  );
}

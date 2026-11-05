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

/** Coming up: how long is left until the reminder's next time (or its 08:00 morning nudge). */
export function ReminderTimeLeft({ day, content }: { day: string; content: JSONContent | null | undefined }) {
  const now = useNow();
  const times = useMemo(() => reminderTimes(content), [content]);
  const timed = times.length > 0;
  const points = timed ? times : [{ hour: MORNING_HOUR, minute: 0, text: "" }];
  const next = points.find((p) => at(day, p.hour, p.minute) > now) ?? null;
  return (
    <span className="rdl-left">
      {next ? (
        <>
          ⏳ <b>{timeLeft(at(day, next.hour, next.minute) - now)}</b> left · {timed ? hhmm(next.hour, next.minute) : `morning nudge ${hhmm(MORNING_HOUR, 0)}`}
        </>
      ) : (
        <>✓ Passed</>
      )}
    </span>
  );
}

/**
 * Today as a line coloured like today's sky where you are (night blue, dawn pink, day, sunset,
 * evening), with a point where each of today's reminders falls, sunrise, sunset and now, and how
 * long is left until the next one.
 */
export function TodayDayLine({ day, items }: { day: string; items: { at: number; text: string; done: boolean }[] }) {
  const now = useNow();
  const sky = useMemo(() => {
    const coords = homeCoords();
    const stops: string[] = [];
    for (let i = 0; i <= 48; i++) stops.push(`${skyAt(at(day, 0, i * 30), coords).bg} ${(i / 48) * 100}%`);
    const sun = sunForDay(new Date(at(day, 12, 0)), coords);
    return { gradient: `linear-gradient(90deg, ${stops.join(", ")})`, sun };
  }, [day]);
  const start = at(day, 0, 0);
  const pctOf = (t: number) => ((t - start) / 86_400_000) * 100;
  const inDay = (p: number) => p >= 0 && p <= 100;
  const next = items.find((i) => !i.done && i.at > now) ?? null;
  const nowPct = pctOf(now);
  const rise = pctOf(sky.sun.rise);
  const set = pctOf(sky.sun.set);
  const clock = (t: number) => {
    const d = new Date(t);
    return hhmm(d.getHours(), d.getMinutes());
  };
  return (
    <div className="reminder-dayline">
      <span className="rdl-left">
        {next ? (
          <>
            ⏳ <b>{timeLeft(next.at - now)}</b> until {clock(next.at)} · {next.text}
          </>
        ) : (
          <>✓ Nothing more today</>
        )}
      </span>
      <span className="rdl-track" style={{ background: sky.gradient }} aria-hidden>
        {inDay(rise) && <i className="rdl-sun" style={{ left: `${rise}%` }} />}
        {inDay(set) && <i className="rdl-sun set" style={{ left: `${set}%` }} />}
        {inDay(nowPct) && <i className="rdl-now" style={{ left: `${nowPct}%` }} />}
        {items.map((it, i) => {
          const p = pctOf(it.at);
          if (!inDay(p)) return null;
          const s = skyAt(it.at);
          return (
            <span key={i} className={`rdl-point${it === next ? " next" : ""}${it.done ? " done" : ""}`} style={{ left: `${p}%` }} title={`${clock(it.at)} ${it.text}`}>
              <span className="rdl-dot" style={{ background: s.bg }} />
              <span className="rdl-time">{s.icon} {clock(it.at)}</span>
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
    </div>
  );
}

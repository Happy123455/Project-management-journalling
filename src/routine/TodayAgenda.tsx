import type React from "react";
import type { JournalStore } from "../store";
import { agendaAction, useTodayAgenda } from "./agenda";
import { writeLog, type RoutineView } from "./routineData";
import { TodayDayLine } from "../calendar/ReminderDayLine";
import { dayKey } from "../lib/timestamp";

/** The reminder's words without its "⏰ 15:00" (the day line shows the time). */
export const withoutTime = (text: string) => text.replace(/^\s*⏰?\s*(?:\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?)?\s*[-–·:]?\s*/i, "").trim() || text;

const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Brings today's note line with this reminder into view and lights it up for a moment. */
export function jumpToLine(text: string) {
  const needle = text.trim().toLowerCase().slice(0, 60);
  if (!needle) return;
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(".tiptap > *"));
  const hit = blocks.find((b) => (b.textContent ?? "").toLowerCase().includes(needle));
  if (!hit) return;
  hit.scrollIntoView({ behavior: "smooth", block: "center" });
  hit.classList.remove("outline-flash");
  void hit.offsetWidth;
  hit.classList.add("outline-flash");
  window.setTimeout(() => hit.classList.remove("outline-flash"), 1600);
}

/**
 * Coming up → Today: today's timed reminders in order with a "now" line between what's past and
 * what's ahead, each with quick actions (✓ done, +15 m, +1 h), and the next step of your usual day.
 */
export function TodayAgenda({ store, view, onOpenRoutine }: { store: JournalStore; view: RoutineView | null; onOpenRoutine: () => void }) {
  const { items, now } = useTodayAgenda(store);
  const next = view?.plan[0];
  const nextStep = next && view?.config.steps.find((s) => s.id === next.id);
  const open = view && view.config.steps.flatMap((s) => (view.filled.get(s.id) ?? []).filter((x) => x.open && !x.estimated && x.end >= view.now - 60_000).map(() => s))[0];
  if (!items.length && !nextStep && !open) return null;
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const dayPct = (t: number) => Math.max(0, Math.min(100, ((t - dayStart) / 86_400_000) * 100));
  const nowAt = items.findIndex((i) => i.at > now);
  const rows = items.map((item) => (
    <li key={item.id} className={item.done ? "agenda-row done" : item.at <= now ? "agenda-row past" : "agenda-row"} style={{ "--p": `${dayPct(item.at)}%` } as React.CSSProperties}>
      {/* An arrow up to this reminder's point on the day line above (its time is shown there). */}
      <span className="agenda-pointer" aria-hidden>
        <i />
      </span>
      <button type="button" className="agenda-text" onClick={() => jumpToLine(item.text)} title={`${clock(item.at)} · show it in the note`}>
        {item.repeat ? "🔁 " : ""}
        {withoutTime(item.text)}
      </button>
      <span className="agenda-actions">
        {item.done ? (
          <button type="button" onClick={() => void agendaAction(store, item, "undo")} aria-label="Not done">↶</button>
        ) : (
          <>
            <button type="button" onClick={() => void agendaAction(store, item, "done")} aria-label="Done">✓</button>
            {!item.repeat && <button type="button" onClick={() => void agendaAction(store, item, 15)}>+15m</button>}
            {!item.repeat && <button type="button" onClick={() => void agendaAction(store, item, 60)}>+1h</button>}
          </>
        )}
      </span>
    </li>
  ));
  rows.splice(nowAt < 0 ? rows.length : nowAt, 0, (
    <li key="now" className="agenda-now"><span className="agenda-time">{clock(now)}</span><span className="agenda-now-line" /><span>now</span></li>
  ));
  return (
    <section className="reminders today-agenda">
      <h2>Today</h2>
      {items.length > 0 && <TodayDayLine day={dayKey(new Date(now))} items={items} onPick={jumpToLine} />}
      <ul>{rows}</ul>
      {view && (open || nextStep) && (
        <div className="agenda-next">
          {open ? (
            <>
              <span>{open.icon} {open.label} · going on</span>
              <button type="button" onClick={() => void writeLog(store, open, "end")}>■ End</button>
            </>
          ) : (
            nextStep && (
              <>
                <span>Usually next: {nextStep.icon} {nextStep.label} ~{clock(next!.start)}</span>
                <button type="button" onClick={() => void writeLog(store, nextStep, nextStep.span ? "start" : "point")}>{nextStep.span ? "▶ Start" : "✓"}</button>
              </>
            )
          )}
          <button type="button" className="agenda-routine" onClick={onOpenRoutine} aria-label="Open the routine">🧭</button>
        </div>
      )}
    </section>
  );
}

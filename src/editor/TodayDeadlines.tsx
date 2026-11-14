import { useMemo, useState } from "react";
import type { JournalStore } from "../store";
import { clock, DAY, hm, midnight, needMins, PLAN_KINDS, progressOf, type Plan } from "../lib/deadline";
import { timeLeft } from "../lib/reminders";
import { fx } from "../lib/fx";
import { changePlansAnywhere, plansOf, useAllDeadlines } from "./deadlineStore";
import { useNow } from "./deadlineBar";
import { startFocus, useFocus } from "./focus";

/**
 * Today's slice of every deadline, on each day's page (wherever the deadline was made): the day's
 * plans on a small bar with the now line, the next plan with ▶ Focus and ✓ Done, time left and progress.
 * Tap the name to open the note it lives in.
 */
export function TodayDeadlines({ store, day, onOpenDay }: { store: JournalStore; day: string; onOpenDay: (d: string) => void }) {
  const all = useAllDeadlines();
  const now = useNow();
  const focus = useFocus();
  const [hidden, setHidden] = useState(false);
  const here = useMemo(() => all.filter((t) => !t.info.status && t.note !== day && t.rows.some((r) => r.day === day)).sort((a, b) => a.endAt - b.endAt), [all, day]);
  if (!here.length) return null;
  const t0 = midnight(day);
  const a = t0 + 6 * 3_600_000;
  const z = t0 + DAY;
  const pct = (t: number) => `${(((Math.min(Math.max(t, a), z) - a) / (z - a)) * 100).toFixed(2)}%`;
  const done = (note: string, tid: string, p: Plan) => {
    fx(p.done ? "undone" : "done");
    void changePlansAnywhere(store, note, tid, (list) => list.map((x) => (x.id === p.id ? { ...x, done: !x.done } : x)));
  };
  return (
    <section className={`tdl${hidden ? " folded" : ""}`} aria-label="Deadlines today">
      <button type="button" className="tdl-head" onClick={() => (fx(hidden ? "open" : "close"), setHidden(!hidden))}>
        ⏳ Deadlines today <small>{here.length}</small> <span>{hidden ? "▸" : "▾"}</span>
      </button>
      {!hidden && here.map((t) => {
        const plans = plansOf(t);
        const today = plans.filter((p) => p.end > t0 && p.start < z).sort((x, y) => x.start - y.start);
        const next = today.find((p) => !p.done && p.end > now);
        const need = needMins(t.info) * 60_000;
        const pr = progressOf(plans, need, now, 0);
        const running = focus?.tid === t.tid && focus.planId === next?.id;
        return (
          <div key={t.tid} className="tdl-card" style={{ ["--dl" as string]: t.info.color }}>
            <div className="tdl-top">
              <button type="button" className="tdl-name" onClick={() => (fx("open"), onOpenDay(t.note))}>{t.info.emoji} {t.title}</button>
              <span className="tdl-left">{t.endAt > now ? `${timeLeft(t.endAt - now)} left` : "due"}</span>
              {need > 0 && <span className="tdl-pr">{hm(pr.done)} / {hm(need)}</span>}
            </div>
            <div className="tdl-bar">
              {today.map((p) => (
                <i key={p.id} className={`tdl-plan${p.done ? " done" : ""}`} style={{ left: pct(p.start), width: `calc(${pct(p.end)} - ${pct(p.start)})`, ["--c" as string]: PLAN_KINDS.find((k) => k.id === (p.kind ?? "focus"))?.color }} title={`${clock(p.start)}–${clock(p.end)} ${p.text}`} />
              ))}
              {t.endAt >= a && t.endAt <= z && <span className="tdl-flag" style={{ left: pct(t.endAt) }}>🏁</span>}
              {now >= a && now <= z && <i className="tdl-now" style={{ left: pct(now) }} />}
            </div>
            {next ? (
              <div className="tdl-next">
                <span><b>{next.start <= now ? "Now" : clock(next.start)}</b> {next.text} <small>{hm(next.end - next.start)}</small></span>
                {!running && <button type="button" onClick={() => startFocus({ note: t.note, tid: t.tid, planId: next.id, title: next.text || t.title, planEnd: next.end })}>▶</button>}
                <button type="button" onClick={() => done(t.note, t.tid, next)} aria-label="Done">✓</button>
              </div>
            ) : (
              <p className="tdl-none">{today.length ? "All of today's plans done 🎉" : "Nothing planned today. Open it to plan some free time."}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

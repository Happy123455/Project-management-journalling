import type { Plan, Step } from "../lib/deadline";
import { clock, DAY, dayLabel, hm, midnight } from "../lib/deadline";
import { addDays, dayKey } from "../lib/timestamp";
import type { Timeline } from "./deadlineStore";

const LABEL = 150;
const COL = 46;
const ROW = 34;
const HEAD = 52;

interface GRow {
  kind: "group" | "step";
  title: string;
  color: string;
  start?: number;
  end?: number;
  /** Planned (solid), or only an estimate from the step's minutes (hatched). */
  planned?: boolean;
  done?: boolean;
  mile?: number;
  due?: number;
  /** Arrow from the row above (the steps follow each other). */
  follows?: boolean;
  tip: string;
}

/** A deadline's rows: its steps in order with their plans' span (or an estimate after the step before), loose plans last. */
export function ganttRows(t: Timeline, now: number): GRow[] {
  const plans: Plan[] = t.rows.flatMap((r) => r.plans);
  const color = t.info.color;
  const out: GRow[] = [{ kind: "group", title: `${t.info.emoji} ${t.title}`, color, due: t.endAt, tip: `Due ${new Date(t.endAt).toLocaleString()}` }];
  const steps: Step[] = t.info.steps ?? [];
  let cursor = Math.max(now, midnight(t.rows[0]?.day ?? dayKey(new Date(now))));
  steps.forEach((s, i) => {
    const mine = plans.filter((p) => p.step === s.id);
    if (mine.length) {
      const start = Math.min(...mine.map((p) => p.start));
      const end = Math.max(...mine.map((p) => p.end));
      cursor = Math.max(cursor, end);
      out.push({ kind: "step", title: s.text, color, start, end, planned: true, done: s.done, mile: s.at, follows: i > 0, tip: `${s.text}: ${mine.length} plan${mine.length === 1 ? "" : "s"}, ${hm(mine.reduce((n, p) => n + p.end - p.start, 0))}` });
    } else {
      // Not planned yet: shown where it would go if worked on straight after the step before.
      const start = cursor;
      const end = Math.min(t.endAt, start + Math.max(30, s.mins || 60) * 60_000);
      cursor = end;
      out.push({ kind: "step", title: s.text, color, start, end: Math.max(end, start + 30 * 60_000), planned: false, done: s.done, mile: s.at, follows: i > 0, tip: `${s.text}: not planned yet (about ${hm((s.mins || 60) * 60_000)})` });
    }
  });
  const loose = plans.filter((p) => !p.step || !steps.some((s) => s.id === p.step)).sort((a, b) => a.start - b.start);
  for (const p of loose) out.push({ kind: "step", title: p.text, color, start: p.start, end: p.end, planned: true, done: p.done, tip: `${p.text} ${clock(p.start)}–${clock(p.end)}` });
  return out;
}

/** ▤ Gantt: every open deadline as a group, its steps as bars across the days, Today line, 🚩 milestones, 🏁 due days. */
export function Gantt({ list, now }: { list: Timeline[]; now: number }) {
  const live = list.filter((t) => !t.info.status && t.endAt > now);
  if (!live.length) return <p className="hint">No open deadlines.</p>;
  const rows = live.flatMap((t) => ganttRows(t, now));
  const first = dayKey(new Date(Math.min(now, ...rows.filter((r) => r.start).map((r) => r.start!))));
  const lastT = Math.max(...live.map((t) => t.endAt), ...rows.filter((r) => r.end).map((r) => r.end!));
  const days: string[] = [];
  for (let d = first; midnight(d) <= lastT && days.length < 42; d = addDays(d, 1)) days.push(d);
  const t0 = midnight(days[0]);
  const x = (t: number) => LABEL + Math.min(Math.max(0, (t - t0) / DAY), days.length) * COL;
  const W = LABEL + days.length * COL + 12;
  const H = HEAD + rows.length * ROW + 8;
  const y = (i: number) => HEAD + i * ROW;
  const today = dayKey(new Date(now));
  return (
    <div className="gantt-scroll">
      <svg className="gantt" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Deadlines as a Gantt chart">
        <defs>
          <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
          </marker>
          <pattern id="gantt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="currentColor" opacity="0.12" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2.5" opacity="0.3" />
          </pattern>
        </defs>
        {days.map((d, i) => {
          const l = dayLabel(d);
          const isToday = d === today;
          return (
            <g key={d}>
              <rect x={LABEL + i * COL + 3} y={HEAD - 4} width={COL - 6} height={H - HEAD} rx={8} className={`gantt-col${l.weekend ? " weekend" : ""}${d < today ? " past" : ""}`} />
              <text x={LABEL + i * COL + COL / 2} y={16} textAnchor="middle" className={`gantt-wd${isToday ? " today" : ""}`}>{isToday ? "Today" : new Date(midnight(d)).toLocaleDateString([], { weekday: "short" })}</text>
              {isToday && <circle cx={LABEL + i * COL + COL / 2} cy={33} r={13} className="gantt-today-dot" />}
              <text x={LABEL + i * COL + COL / 2} y={38} textAnchor="middle" className={`gantt-dn${isToday ? " today" : ""}${l.weekend ? " weekend" : ""}`}>{new Date(midnight(d)).getDate()}</text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          const top = y(i);
          if (r.kind === "group") {
            return (
              <g key={`g${i}`} style={{ color: r.color }}>
                {i > 0 && <line x1={8} x2={W - 8} y1={top + 2} y2={top + 2} className="gantt-sep" />}
                <text x={10} y={top + ROW / 2 + 9} className="gantt-group">{r.title.toUpperCase()}</text>
                {r.due && (
                  <g>
                    <line x1={x(r.due)} x2={x(r.due)} y1={HEAD - 4} y2={H} className="gantt-due" />
                    <text x={x(r.due)} y={top + ROW / 2 + 9} textAnchor="middle" fontSize={14}>🏁</text>
                  </g>
                )}
              </g>
            );
          }
          const sx = x(r.start!);
          const ex = Math.max(sx + 8, x(r.end!));
          const prev = rows[i - 1];
          return (
            <g key={`s${i}`} style={{ color: r.color }}>
              <title>{r.tip}</title>
              <text x={16} y={top + ROW / 2 + 5} className={`gantt-task${r.done ? " done" : ""}`}>{r.title.length > 20 ? `${r.title.slice(0, 19)}…` : r.title}</text>
              {r.follows && prev?.kind === "step" && prev.end && (
                <path
                  d={`M${Math.max(x(prev.start!) + 8, x(prev.end))} ${top - ROW / 2 + 2} h6 V${top + ROW / 2} H${sx - 2}`}
                  className="gantt-link"
                  markerEnd={sx - 2 > Math.max(x(prev.start!) + 8, x(prev.end)) + 6 ? "url(#gantt-arrow)" : undefined}
                />
              )}
              <rect x={sx} y={top + 7} width={ex - sx} height={ROW - 14} rx={(ROW - 14) / 2} fill={r.planned ? "currentColor" : "url(#gantt-hatch)"} className={`gantt-bar${r.done ? " done" : ""}${r.planned ? "" : " est"}`} />
              {r.mile && (
                <g transform={`translate(${x(r.mile)} ${top + ROW / 2}) rotate(45)`}>
                  <rect x={-7} y={-7} width={14} height={14} rx={2} className="gantt-mile" />
                </g>
              )}
            </g>
          );
        })}
        {now >= t0 && <line x1={x(now)} x2={x(now)} y1={HEAD - 4} y2={H} className="gantt-now" />}
      </svg>
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Plan, Step } from "../lib/deadline";
import { clock, DAY, hm, midnight } from "../lib/deadline";
import { anchoredScroll, clampZoom, DEFAULT_PX_PER_DAY, inHistory, levelFor, PRESETS, scaleTicks } from "../lib/ganttScale";
import { dayKey } from "../lib/timestamp";
import type { Timeline } from "./deadlineStore";

const ROW = 34;
const HEAD = 52;
const ZOOM_KEY = "dynamic-journal.gantt-zoom";

interface GRow {
  kind: "group" | "step";
  /** The deadline (group rows), to open it. */
  tid?: string;
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
  const out: GRow[] = [{ kind: "group", tid: t.tid, title: `${t.info.emoji} ${t.title}`, color, due: t.endAt, tip: `Due ${new Date(t.endAt).toLocaleString()}` }];
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


function loadZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return v > 0 ? clampZoom(v) : DEFAULT_PX_PER_DAY;
  } catch {
    return DEFAULT_PX_PER_DAY;
  }
}

/** Two fingers' distance and middle. */
const pinchOf = (a: Touch, b: Touch) => ({ d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), x: (a.clientX + b.clientX) / 2 });

/**
 * ▤ Gantt: every open deadline as a group, its steps as bars, Today line, 🚩 milestones, 🏁 due
 * times. Pinch (fingers or trackpad) or the buttons zoom from hours to months; the moment under
 * your fingers stays put. Done, archived and past deadlines wait in a folded History below.
 */
export function Gantt({ list, now, onPick }: { list: Timeline[]; now: number; onPick?: (tid: string) => void }) {
  const live = useMemo(() => list.filter((t) => !inHistory(t, now)), [list, now]);
  const history = useMemo(() => list.filter((t) => inHistory(t, now)).sort((a, b) => b.endAt - a.endAt), [list, now]);
  const rows = useMemo(() => live.flatMap((t) => ganttRows(t, now)), [live, now]);
  const { t0, t1 } = useMemo(() => {
    const starts = rows.filter((r) => r.start).map((r) => r.start!);
    const ends = [...live.map((t) => t.endAt), ...rows.filter((r) => r.end).map((r) => r.end!)];
    const a = midnight(dayKey(new Date(Math.min(now, ...starts)))) - DAY;
    const b = Math.max(now + 7 * DAY, ...ends) + 2 * DAY;
    return { t0: a, t1: Math.min(b, a + 400 * DAY) };
  }, [rows, live, now]);
  const spanDays = (t1 - t0) / DAY;
  const spanRef = useRef(spanDays);
  spanRef.current = spanDays;

  const pane = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(loadZoom);
  const pxRef = useRef(px);
  const [view, setView] = useState({ left: 0, width: 800 });
  const pending = useRef<number | null>(null);
  const level = levelFor(px);

  const labelWidth = () => labels.current?.offsetWidth ?? 0;
  const visibleWidth = () => Math.max(1, (pane.current?.clientWidth ?? 800) - labelWidth());

  /** Zooms by `factor` keeping the moment at `anchorX` (px into the visible chart) in place. */
  const zoomBy = useCallback(
    (factor: number, anchorX?: number) => {
      const el = pane.current;
      if (!el) return;
      const old = pxRef.current;
      const vis = visibleWidth();
      const next = clampZoom(old * factor, vis / spanRef.current);
      if (Math.abs(next - old) < 0.001) return;
      pending.current = anchoredScroll(el.scrollLeft, anchorX ?? vis / 2, old, next);
      pxRef.current = next;
      setPx(next);
    },
    // Reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // After a zoom renders: scroll so the anchored moment stays put; remember the zoom.
  useLayoutEffect(() => {
    const el = pane.current;
    if (el && pending.current != null) {
      el.scrollLeft = pending.current;
      pending.current = null;
    }
    if (el) setView({ left: el.scrollLeft, width: visibleWidth() });
    const keep = window.setTimeout(() => {
      try {
        localStorage.setItem(ZOOM_KEY, String(Math.round(px * 100) / 100));
      } catch {
        // Only a convenience.
      }
    }, 500);
    return () => window.clearTimeout(keep);
  }, [px]);

  // Opens with today a little in from the left.
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, ((now - t0) / DAY) * pxRef.current - visibleWidth() * 0.2);
    setView({ left: el.scrollLeft, width: visibleWidth() });
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pinch with two fingers, a trackpad pinch (Ctrl+wheel, or Safari's gesture events), Ctrl/⌘ +/-.
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    let pinch: { d: number; x: number } | null = null;
    let gesture = 0;
    let frame = 0;
    let factor = 1;
    let anchor = 0;
    const anchorAt = (clientX: number) => clientX - el.getBoundingClientRect().left - labelWidth();
    const queue = (f: number, clientX: number) => {
      factor *= f;
      anchor = anchorAt(clientX);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const f2 = factor;
        factor = 1;
        zoomBy(f2, anchor);
      });
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = pinchOf(e.touches[0], e.touches[1]);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinch) return;
      e.preventDefault();
      const p = pinchOf(e.touches[0], e.touches[1]);
      if (pinch.d > 0) queue(p.d / pinch.d, p.x);
      pinch = p;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || gesture) return;
      e.preventDefault();
      queue(Math.exp(-e.deltaY * 0.01), e.clientX);
    };
    type GestureEvt = Event & { scale: number; clientX: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesture = 1;
    };
    const onGestureChange = (e: Event) => {
      const g = e as GestureEvt;
      e.preventDefault();
      if (gesture > 0 && g.scale > 0) queue(g.scale / gesture, g.clientX);
      gesture = g.scale || 1;
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesture = 0;
    };
    let scrollFrame = 0;
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        // Only the hour view draws just what's in sight; the others draw everything once.
        if (levelFor(pxRef.current) === "hour") setView({ left: el.scrollLeft, width: visibleWidth() });
      });
    };
    const onResize = () => setView({ left: el.scrollLeft, width: visibleWidth() });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(scrollFrame);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [zoomBy]);

  const toToday = () => {
    const el = pane.current;
    if (el) el.scrollTo({ left: Math.max(0, ((now - t0) / DAY) * pxRef.current - visibleWidth() * 0.2), behavior: "smooth" });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomBy(1.4);
    else if (e.key === "-") zoomBy(1 / 1.4);
    else if (e.key.toLowerCase() === "t") toToday();
    else return;
    e.preventDefault();
  };

  const W = Math.ceil(spanDays * px);
  const H = rows.length * ROW + 8;
  const x = (t: number) => Math.min(Math.max(0, ((t - t0) / DAY) * px), W);
  const scale = useMemo(() => {
    if (level !== "hour") return scaleTicks(t0, t1, px, now);
    // Zoomed in: only the stretch in sight (and a screen either side).
    const from = t0 + ((view.left - view.width) / px) * DAY;
    const to = t0 + ((view.left + 2 * view.width) / px) * DAY;
    return scaleTicks(Math.max(t0, from), Math.min(t1, to), px, now);
  }, [level, t0, t1, px, now, view]);

  const history$ = history.length > 0 && (
    <details className="tl-history">
      <summary>History · {history.length}</summary>
      <ul className="tl-list">
        {history.map((t) => (
          <li key={t.tid} className={t.info.status ? `is-${t.info.status}` : "is-past"} style={{ ["--c" as string]: t.info.color }}>
            <button type="button" onClick={() => onPick?.(t.tid)}>
              <strong>{t.info.emoji} {t.title}{t.info.status === "done" ? " ✓" : ""}</strong>
              <span>{t.info.status === "archived" ? "Archived" : t.info.status === "done" ? "Done" : t.endAt <= now ? "Past" : "All steps done"} · due {new Date(t.endAt).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );

  if (!live.length) {
    return (
      <div className="gantt-wrap">
        <p className="hint">No open deadlines.</p>
        {history$}
      </div>
    );
  }

  return (
    <div className="gantt-wrap">
      <div className="gantt-tools" role="toolbar" aria-label="Zoom">
        {PRESETS.map((p) => (
          <button key={p.level} type="button" className={level === p.level ? "on" : ""} onClick={() => zoomBy(p.px / pxRef.current)}>
            {p.label}
          </button>
        ))}
        <button type="button" className="gantt-today-btn" onClick={toToday}>Today</button>
      </div>
      <div className="gantt-pane" ref={pane} tabIndex={0} onKeyDown={onKeyDown} aria-label="Deadlines as a Gantt chart. Pinch, or press + and −, to zoom; T for today.">
        <div className="gantt-grid" style={{ gridTemplateColumns: `auto ${W}px`, gridTemplateRows: `${HEAD}px auto` }}>
          <div className="gantt-corner" />
          <svg className="gantt-head" width={W} height={HEAD} aria-hidden>
            {scale.major.map((m) => (
              <text key={`M${m.t}`} x={x(m.t) + 4} y={14} className={`gantt-major${m.today ? " today" : ""}`}>{m.label}</text>
            ))}
            {scale.minor.map((m) => {
              if (level === "day") {
                const cx = x(m.t) + px / 2;
                return (
                  <g key={`m${m.t}`}>
                    <text x={cx} y={28} textAnchor="middle" className={`gantt-wd${m.today ? " today" : ""}`}>{px >= 40 ? m.sub : m.sub?.[0]}</text>
                    {m.today && <circle cx={cx} cy={40} r={10} className="gantt-today-dot" />}
                    <text x={cx} y={44} textAnchor="middle" className={`gantt-dn${m.today ? " today" : ""}${m.weekend ? " weekend" : ""}`}>{m.label}</text>
                  </g>
                );
              }
              return (
                <g key={`m${m.t}`}>
                  <line x1={x(m.t)} x2={x(m.t)} y1={30} y2={HEAD} className="gantt-tick" />
                  <text x={x(m.t) + 4} y={44} className={`gantt-minor${m.today ? " today" : ""}`}>{m.label}{m.sub ? ` ${m.sub}` : ""}</text>
                </g>
              );
            })}
          </svg>
          <div className="gantt-labels" ref={labels}>
            {rows.map((r, i) =>
              r.kind === "group" ? (
                <button key={`l${i}`} type="button" className="gantt-l group" style={{ color: r.color, height: ROW }} onClick={() => r.tid && onPick?.(r.tid)} title={r.tip}>
                  {r.title}
                </button>
              ) : (
                <div key={`l${i}`} className={`gantt-l${r.done ? " done" : ""}`} style={{ height: ROW }} title={r.tip}>
                  {r.title}
                </div>
              ),
            )}
          </div>
          <svg className="gantt" width={W} height={H} role="img" aria-label="Deadline steps as bars">
            <defs>
              <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
              </marker>
              <pattern id="gantt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="currentColor" opacity="0.12" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2.5" opacity="0.3" />
              </pattern>
            </defs>
            {scale.bands.map((b) =>
              level === "day" ? (
                <rect key={`b${b.from}`} x={x(b.from) + Math.min(3, px * 0.08)} y={2} width={Math.max(1, x(b.to) - x(b.from) - Math.min(6, px * 0.16))} height={H - 4} rx={Math.min(8, px / 5)} className={`gantt-col${b.kind === "weekend" ? " weekend" : ""}${b.past ? " past" : ""}`} />
              ) : b.kind !== "plain" ? (
                <rect key={`b${b.from}`} x={x(b.from)} y={0} width={Math.max(0, x(b.to) - x(b.from))} height={H} className={`gantt-band ${b.kind}${b.past ? " past" : ""}`} />
              ) : null,
            )}
            {level !== "day" && scale.minor.map((m) => <line key={`g${m.t}`} x1={x(m.t)} x2={x(m.t)} y1={0} y2={H} className="gantt-grid-line" />)}
            {rows.map((r, i) => {
              const top = i * ROW;
              if (r.kind === "group") {
                return (
                  <g key={`g${i}`} style={{ color: r.color }}>
                    {i > 0 && <line x1={0} x2={W} y1={top + 1} y2={top + 1} className="gantt-sep" />}
                    {r.due && (
                      <g>
                        <line x1={x(r.due)} x2={x(r.due)} y1={top + 4} y2={H} className="gantt-due" />
                        <text x={x(r.due)} y={top + ROW / 2 + 6} textAnchor="middle" fontSize={14}>🏁</text>
                      </g>
                    )}
                  </g>
                );
              }
              const sx = x(r.start!);
              const ex = Math.max(sx + 6, x(r.end!));
              const prev = rows[i - 1];
              const inside = ex - sx > 56 ? (r.title.length * 6.4 > ex - sx - 14 ? `${r.title.slice(0, Math.max(1, Math.floor((ex - sx - 20) / 6.4)))}…` : r.title) : "";
              return (
                <g key={`s${i}`} style={{ color: r.color }}>
                  <title>{r.tip}</title>
                  {r.follows && prev?.kind === "step" && prev.end && (
                    <path
                      d={`M${Math.max(x(prev.start!) + 6, x(prev.end))} ${top - ROW / 2 + 2} h6 V${top + ROW / 2} H${sx - 2}`}
                      className="gantt-link"
                      markerEnd={sx - 2 > Math.max(x(prev.start!) + 6, x(prev.end)) + 6 ? "url(#gantt-arrow)" : undefined}
                    />
                  )}
                  <rect x={sx} y={top + 7} width={ex - sx} height={ROW - 14} rx={(ROW - 14) / 2} fill={r.planned ? "currentColor" : "url(#gantt-hatch)"} className={`gantt-bar${r.done ? " done" : ""}${r.planned ? "" : " est"}`} />
                  {inside && <text x={sx + 10} y={top + ROW / 2 + 4} className={`gantt-in${r.planned ? "" : " est"}`}>{inside}</text>}
                  {r.mile && (
                    <g transform={`translate(${x(r.mile)} ${top + ROW / 2}) rotate(45)`}>
                      <rect x={-7} y={-7} width={14} height={14} rx={2} className="gantt-mile" />
                    </g>
                  )}
                </g>
              );
            })}
            {now >= t0 && now <= t1 && <line x1={x(now)} x2={x(now)} y1={0} y2={H} className="gantt-now" />}
          </svg>
        </div>
      </div>
      <p className="hint gantt-hint">Pinch to zoom between hours, days, weeks and months.</p>
      {history$}
    </div>
  );
}

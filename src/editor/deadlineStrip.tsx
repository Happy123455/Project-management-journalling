import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { busyOn, clock, DAY, dayLabel, freeGaps, hm, midnight, type Busy, type Layer, type Plan } from "../lib/deadline";
import { reminderTimes } from "../lib/reminders";
import { dayKey } from "../lib/timestamp";
import { randomLid } from "../sync/lineIds";
import { Planner } from "./deadlinePlanner";
import { journalStore } from "./attachments";
import type { RoutineView } from "../routine/routineData";

const MIN = 60_000;
const HOUR = 60 * MIN;
const SNAP = 2 * MIN;
const snap = (t: number) => Math.round(t / SNAP) * SNAP;

export interface StripComment {
  id: string;
  at: number;
  text: string;
  page?: string;
}

/** Every bar of one deadline in the open note: day, plans, comments. */
function rowsOf(editor: Editor, tid: string) {
  const out: { day: string; plans: Plan[]; comments: StripComment[] }[] = [];
  editor.state.doc.forEach((n) => {
    if (n.type.name === "deadlineBar" && n.attrs.tid === tid && n.attrs.day) out.push({ day: n.attrs.day, plans: n.attrs.plans ?? [], comments: n.attrs.comments ?? [] });
  });
  return out;
}

/** Writes plans/comments back to the bars of their days (a plan belongs to the day it starts on). */
function writeBack(editor: Editor, tid: string, field: "plans" | "comments", list: (Plan | StripComment)[]) {
  const tr = editor.state.tr;
  const days: string[] = [];
  editor.state.doc.forEach((n) => void (n.type.name === "deadlineBar" && n.attrs.tid === tid && n.attrs.day && days.push(n.attrs.day)));
  if (!days.length) return;
  // Something on a day without its own bar goes on the nearest one, never dropped.
  const home = (x: Plan | StripComment) => {
    const d = dayKey(new Date("start" in x ? x.start : x.at));
    return d < days[0] ? days[0] : d > days[days.length - 1] ? days[days.length - 1] : days.includes(d) ? d : days.filter((k) => k <= d).pop()!;
  };
  editor.state.doc.forEach((n, pos) => {
    if (n.type.name !== "deadlineBar" || n.attrs.tid !== tid || !n.attrs.day) return;
    const mine = list.filter((x) => home(x) === n.attrs.day);
    if (JSON.stringify(mine) !== JSON.stringify(n.attrs[field] ?? [])) tr.setNodeMarkup(pos, undefined, { ...n.attrs, [field]: mine });
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

type Drag =
  | { kind: "select"; anchor: number; at: number }
  | { kind: "move"; id: string; grab: number; start: number; end: number }
  | { kind: "edge"; id: string; side: "start" | "end"; start: number; end: number };

/**
 * A deadline opened up under its bars: every day of it on one long line (like a week calendar),
 * zoomed in, scrolling sideways from day to day, with the now line. Pinch (or ctrl+wheel) zooms;
 * at close zoom the lines are 2 minutes apart. Swipe across empty time to select it (on a phone,
 * turn on ✎ first so a swipe selects instead of scrolling), then name it to plan it or drop a 💬.
 * Plans can be dragged, and their ends dragged to change how long they take.
 */
export function DeadlineStrip({ editor, tid, endAt, layer, view, now, focus, onClose, onComment }: {
  editor: Editor;
  tid: string;
  endAt: number;
  layer: Layer;
  view: RoutineView | null;
  now: number;
  focus: number;
  onClose: () => void;
  onComment: (c: StripComment) => void;
}) {
  const rows = rowsOf(editor, tid);
  const days = rows.map((r) => r.day);
  const t0 = days.length ? midnight(days[0]) : midnight(dayKey(new Date(focus)));
  const t1 = days.length ? midnight(days[days.length - 1]) + DAY : t0 + DAY;
  const plans = rows.flatMap((r) => r.plans);
  const comments = rows.flatMap((r) => r.comments);
  const [pxh, setPxh] = useState(140); // pixels per hour
  const [edit, setEdit] = useState(!matchMedia("(pointer: coarse)").matches);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ai, setAi] = useState<{ start: number; end: number } | null>(null);
  const [reminders, setReminders] = useState<{ at: number; text: string }[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ dist: number; pxh: number; at: number } | null>(null);
  const keepAt = useRef<{ t: number; x: number } | null>({ t: focus, x: 0.35 });

  const busy: Busy[] = useMemo(() => (view ? days.flatMap((d) => busyOn(d, layer, view.config, view.stats, view.days)) : []), [view, days.join(), layer]);
  const taken = [...busy, ...plans.map((p) => ({ ...p, icon: "", label: p.text }))];
  const free = freeGaps(Math.max(t0, now), Math.min(t1, endAt), taken);

  useEffect(() => {
    const store = journalStore();
    if (!store) return;
    void Promise.all(days.map((d) => store.getDay(d).then((p) => reminderTimes(p?.content).map((r) => ({ at: midnight(d) + (r.hour * 60 + r.minute) * MIN, text: r.text }))))).then((l) => setReminders(l.flat()));
  }, [days.join()]);

  const x = (t: number) => ((t - t0) / HOUR) * pxh;
  const tAt = (clientX: number) => {
    const el = scroller.current!;
    const box = el.getBoundingClientRect();
    return t0 + ((clientX - box.left + el.scrollLeft) / pxh) * HOUR;
  };
  // Keep the same moment under the same spot when zooming (and open at the tapped time).
  useLayoutEffect(() => {
    const el = scroller.current;
    const k = keepAt.current;
    if (!el || !k) return;
    el.scrollLeft = x(k.t) - el.clientWidth * k.x;
    keepAt.current = null;
  }, [pxh]);
  const zoomTo = (next: number, aroundClientX?: number) => {
    const el = scroller.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const cx = aroundClientX ?? box.left + box.width / 2;
    keepAt.current = { t: tAt(cx), x: (cx - box.left) / box.width };
    setPxh(Math.min(1800, Math.max(20, next)));
  };

  const savePlans = (list: Plan[]) => writeBack(editor, tid, "plans", list.sort((a, b) => a.start - b.start));
  const onDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, e.clientX);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.abs(a - b), pxh, at: (a + b) / 2 };
      setDrag(null);
      return;
    }
    if (!edit && e.pointerType === "touch") return;
    const target = e.target as HTMLElement;
    const pid = target.closest<HTMLElement>("[data-plan]")?.dataset.plan;
    const t = tAt(e.clientX);
    if (pid) {
      const p = plans.find((q) => q.id === pid)!;
      const side = target.dataset.edge as "start" | "end" | undefined;
      setDrag(side ? { kind: "edge", id: pid, side, start: p.start, end: p.end } : { kind: "move", id: pid, grab: t - p.start, start: p.start, end: p.end });
      setPicked(pid);
      setName(p.text);
    } else if (!target.closest(".ds-dot, .ds-form")) {
      setDrag({ kind: "select", anchor: snap(t), at: snap(t) });
      setPicked(null);
      setSel(null);
    } else return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, e.clientX);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.max(10, Math.abs(a - b));
      zoomTo((pinch.current.pxh * d) / Math.max(10, pinch.current.dist), pinch.current.at);
      return;
    }
    if (!drag) return;
    const t = snap(tAt(e.clientX));
    if (drag.kind === "select") setDrag({ ...drag, at: t });
    else if (drag.kind === "move") {
      const len = drag.end - drag.start;
      const start = snap(tAt(e.clientX) - drag.grab);
      setDrag({ ...drag, start, end: start + len });
    } else if (drag.side === "start") setDrag({ ...drag, start: Math.min(t, drag.end - SNAP) });
    else setDrag({ ...drag, end: Math.max(t, drag.start + SNAP) });
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!drag) return;
    if (drag.kind === "select") {
      const [s, en] = [Math.min(drag.anchor, drag.at), Math.max(drag.anchor, drag.at)];
      setSel({ start: s, end: en });
      setName("");
    } else {
      savePlans(plans.map((p) => (p.id === drag.id ? { ...p, start: drag.start, end: drag.end } : p)));
    }
    setDrag(null);
  };

  const shown = (p: Plan) => (drag && drag.kind !== "select" && drag.id === p.id ? { ...p, start: drag.start, end: drag.end } : p);
  const selection = drag?.kind === "select" ? { start: Math.min(drag.anchor, drag.at), end: Math.max(drag.anchor, drag.at) } : sel;
  const step = pxh >= 900 ? 2 : pxh >= 360 ? 10 : pxh >= 120 ? 30 : 60; // grid minutes
  const lines: number[] = [];
  for (let t = t0; t <= t1 && lines.length < 4000; t += step * MIN) lines.push(t);
  const label = pxh >= 60 ? 1 : pxh >= 30 ? 3 : 6; // hour label every n hours
  const pickedPlan = plans.find((p) => p.id === picked);

  const addPlan = () => {
    if (!sel) return;
    const len = Math.max(SNAP, sel.end - sel.start) || 30 * MIN;
    savePlans([...plans, { id: randomLid(), start: sel.start, end: sel.start + len, text: name.trim() || "Plan" }]);
    setSel(null);
  };
  const addComment = () => {
    if (!sel) return;
    const c = { id: randomLid(), at: sel.start, text: name.trim() };
    writeBack(editor, tid, "comments", [...comments, c].sort((a, b) => a.at - b.at));
    setSel(null);
    if (!c.text) onComment(c);
  };

  return (
    <div className="ds">
      <div className="ds-tools">
        <button type="button" onClick={() => zoomTo(pxh / 1.6)} aria-label="Zoom out">－</button>
        <button type="button" onClick={() => zoomTo(pxh * 1.6)} aria-label="Zoom in">＋</button>
        <span className="hint">{step} min lines</span>
        <button type="button" className={edit ? "on" : ""} onClick={() => setEdit(!edit)} title="Swipe to select time (instead of scrolling)">✎ Select</button>
        <button type="button" onClick={() => ((keepAt.current = { t: now, x: 0.35 }), setPxh((p) => p + 0.001))}>Now</button>
        <button
          type="button"
          onClick={() => {
            const el = scroller.current;
            const mid = el ? tAt(el.getBoundingClientRect().left + el.clientWidth / 2) : now;
            const gaps = freeGaps(Math.max(t0, now), Math.min(t1, endAt), busy);
            const g = gaps.find((f) => f.end > mid) ?? gaps[gaps.length - 1];
            if (g) setAi(g);
          }}
          title="Let AI plan the free time here"
        >✨</button>
        <button type="button" onClick={onClose} aria-label="Close" className="ds-close">✕</button>
      </div>
      <div
        ref={scroller}
        className={`ds-scroll${edit ? " editing" : ""}`}
        onWheel={(e) => (e.ctrlKey || e.metaKey) && (e.preventDefault(), zoomTo(pxh * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX))}
      >
        <div className="ds-track" style={{ width: x(t1) }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {days.map((d) => {
            const l = dayLabel(d);
            return <div key={d} className={`ds-day${l.weekend ? " weekend" : ""}`} style={{ left: x(midnight(d)), width: x(midnight(d) + DAY) - x(midnight(d)) }}><b>{l.text}</b></div>;
          })}
          {lines.map((t) => {
            const hour = new Date(t).getMinutes() === 0;
            const h = new Date(t).getHours();
            return (
              <i key={t} className={`ds-line${hour ? " hour" : ""}${h === 0 && hour ? " midnight" : ""}`} style={{ left: x(t) }}>
                {hour && h % label === 0 && <small>{String(h).padStart(2, "0")}</small>}
              </i>
            );
          })}
          {now > t0 && <div className="ds-past" style={{ width: x(Math.min(now, t1)) }} />}
          {endAt < t1 && <div className="ds-after" style={{ left: x(endAt), width: x(t1) - x(endAt) }} />}
          {busy.map((b, i) => (
            <div key={i} className={`ds-busy${b.sleep ? " sleep" : ""}`} style={{ left: x(b.start), width: x(b.end) - x(b.start) }}>
              <span>{b.icon} {x(b.end) - x(b.start) > 70 ? `${b.label} ${clock(b.start)}–${clock(b.end)}` : ""}</span>
            </div>
          ))}
          {free.map((f, i) => (
            <div key={i} className="ds-free" style={{ left: x(f.start), width: x(f.end) - x(f.start) }}>
              {x(f.end) - x(f.start) > 44 && <span>{hm(f.end - f.start)} free</span>}
            </div>
          ))}
          {plans.map(shown).map((p) => (
            <div key={p.id} data-plan={p.id} className={`ds-plan${p.ai ? " ai" : ""}${picked === p.id ? " picked" : ""}`} style={{ left: x(p.start), width: Math.max(4, x(p.end) - x(p.start)) }}>
              <i data-edge="start" className="ds-edge" />
              <span>{p.text} <small>{clock(p.start)}–{clock(p.end)}</small></span>
              <i data-edge="end" className="ds-edge right" />
            </div>
          ))}
          {reminders.map((r, i) => <span key={i} className="ds-rem" style={{ left: x(r.at) }} title={r.text}>🔔{clock(r.at)}</span>)}
          {comments.map((c) => <button key={c.id} type="button" className="ds-dot" style={{ left: x(c.at) }} title={`${clock(c.at)} ${c.text}`} onClick={() => onComment(c)} />)}
          {selection && <div className="ds-sel" style={{ left: x(selection.start), width: Math.max(2, x(selection.end) - x(selection.start)) }}><small>{clock(selection.start)}–{clock(selection.end)} · {hm(selection.end - selection.start)}</small></div>}
          {now >= t0 && now <= t1 && <i className="ds-now" style={{ left: x(now) }}><small>{clock(now)}</small></i>}
          {endAt >= t0 && endAt <= t1 && <span className="ds-flag" style={{ left: x(endAt) }}>🏁</span>}
        </div>
      </div>
      {sel && !drag && (
        <div className="ds-form">
          <b>{clock(sel.start)}{sel.end > sel.start ? `–${clock(sel.end)} · ${hm(sel.end - sel.start)}` : ""}</b>
          <input autoFocus placeholder="What goes here?" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPlan()} />
          <button type="button" onClick={addPlan}>Plan it</button>
          <button type="button" onClick={addComment}>💬</button>
          <button type="button" onClick={() => setSel(null)} aria-label="Cancel">✕</button>
        </div>
      )}
      {pickedPlan && !drag && !sel && (
        <div className="ds-form">
          <b>{clock(pickedPlan.start)}–{clock(pickedPlan.end)} · {hm(pickedPlan.end - pickedPlan.start)}</b>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== pickedPlan.text && savePlans(plans.map((p) => (p.id === picked ? { ...p, text: name.trim() } : p)))} />
          <button type="button" onClick={() => (savePlans(plans.filter((p) => p.id !== picked)), setPicked(null))} aria-label="Delete">🗑</button>
          <button type="button" onClick={() => setPicked(null)} aria-label="Done">✓</button>
        </div>
      )}
      {ai && (
        <Planner
          start={ai.start}
          end={ai.end}
          busy={busy.filter((b) => b.end > ai.start - HOUR && b.start < ai.end + HOUR)}
          plans={plans}
          prefs={String(editor.state.doc.content.content.find((n) => n.attrs.tid === tid && n.attrs.first)?.attrs.prefs ?? "")}
          onPlans={savePlans}
          onPrefs={(p) => {
            const tr = editor.state.tr;
            editor.state.doc.forEach((n, pos) => void (n.attrs.tid === tid && n.type.name === "deadlineBar" && tr.setNodeMarkup(pos, undefined, { ...n.attrs, prefs: p })));
            editor.view.dispatch(tr);
          }}
          onClose={() => setAi(null)}
        />
      )}
    </div>
  );
}

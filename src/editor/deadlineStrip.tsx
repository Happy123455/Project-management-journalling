import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { busyOn, clock, DAY, dayLabel, freeGaps, hm, midnight, overlaps, PLAN_KINDS, PLAN_ROWS, planLanes, pushLater, skyGradient, snapTime, type Busy, type Layer, type Plan, type Step } from "../lib/deadline";
import { reminderTimes } from "../lib/reminders";
import { dayKey } from "../lib/timestamp";
import { fx } from "../lib/fx";
import { randomLid } from "../sync/lineIds";
import { Planner } from "./deadlinePlanner";
import { journalStore } from "./attachments";
import { barsOf, headOf, savePlans, setAll, writeBack } from "./deadlineStore";
import type { RoutineView } from "../routine/routineData";

const MIN = 60_000;
const HOUR = 60 * MIN;
const LONG_PRESS = 420;
/** Height of one plan lane on the line (a block dragged this far up or down changes lane). */
const LANE = 34;
const MAGNET_PX = 10;

export interface StripComment {
  id: string;
  at: number;
  text: string;
  page?: string;
}

/** Every bar of one deadline in the open note: day, plans, comments. */
function rowsOf(editor: Editor, tid: string) {
  return barsOf(editor, tid).map((b) => ({ day: b.attrs.day as string, plans: (b.attrs.plans as Plan[]) ?? [], comments: (b.attrs.comments as StripComment[]) ?? [] }));
}

type Drag =
  | { kind: "select"; anchor: number; at: number }
  | { kind: "move"; ids: string[]; grab: number; delta: number; moved: boolean; origin: number; y: number; rows: number }
  | { kind: "edge"; id: string; side: "start" | "end"; start: number; end: number };

const kindColor = (p: Plan) => PLAN_KINDS.find((k) => k.id === (p.kind ?? "focus"))?.color;

/**
 * A deadline opened up under its bars: every day of it on one long line (like a week calendar),
 * zoomed in, scrolling sideways from day to day, with the now line. Pinch (or ctrl+wheel) zooms;
 * at close zoom the lines are 2 minutes apart. Swipe across empty time to select it (on a phone,
 * turn on ✎ first so a swipe selects instead of scrolling), then name it to plan it or drop a 💬.
 * Plans move by dragging and stretch by their ends; they snap to the chosen grid and click onto
 * nearby edges (routine, other plans, now) with a tick. Long-press (or shift-click) picks several
 * to move together. Tap a plan to open every detail of it.
 */
export function DeadlineStrip({ editor, tid, endAt, layer, view, now, focus, others, steps, onClose, onComment, onOpenPlan }: {
  editor: Editor;
  tid: string;
  endAt: number;
  layer: Layer;
  view: RoutineView | null;
  now: number;
  focus: number;
  /** Plans of other deadlines (they take time too). */
  others: (Plan & { color: string; title: string })[];
  steps: Step[];
  onClose: () => void;
  onComment: (c: StripComment) => void;
  onOpenPlan: (id: string) => void;
}) {
  const rows = rowsOf(editor, tid);
  const days = rows.map((r) => r.day);
  const t0 = days.length ? midnight(days[0]) : midnight(dayKey(new Date(focus)));
  const t1 = days.length ? midnight(days[days.length - 1]) + DAY : t0 + DAY;
  const plans = rows.flatMap((r) => r.plans);
  const lanes = planLanes(plans);
  const comments = rows.flatMap((r) => r.comments);
  const head = headOf(editor, tid);
  const snapMins = Number(head?.snap) || 5;
  const [pxh, setPxh] = useState(140); // pixels per hour
  const [edit, setEdit] = useState(!matchMedia("(pointer: coarse)").matches);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [clash, setClash] = useState<{ list: Plan[]; ids: string[]; message: string } | null>(null);
  const [name, setName] = useState("");
  const [ai, setAi] = useState<{ start: number; end: number } | null>(null);
  const [reminders, setReminders] = useState<{ at: number; text: string }[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ dist: number; pxh: number; at: number } | null>(null);
  const keepAt = useRef<{ t: number; x: number } | null>({ t: focus, x: 0.35 });
  const press = useRef<{ timer: number; id: string; x: number; y: number } | null>(null);
  const lastSnap = useRef<number>(0);

  // The same colours as the bars: night blue to dawn to day to dusk as the line goes along.
  const sky = useMemo(() => skyGradient(t0, t1, Math.min(400, Math.round((t1 - t0) / HOUR))), [t0, t1]);
  const busy: Busy[] = useMemo(() => (view ? days.flatMap((d) => busyOn(d, layer, view.config, view.stats, view.days)) : []), [view, days.join(), layer]);
  const taken = [...busy, ...plans.map((p) => ({ ...p, icon: "", label: p.text })), ...others.map((p) => ({ ...p, icon: "", label: p.text }))];
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

  /** Edges a moving time clicks onto: routine, other plans (not the ones moving), now, the deadline. */
  const edgesExcept = (ids: string[]) => [
    ...busy.flatMap((b) => [b.start, b.end]),
    ...plans.filter((p) => !ids.includes(p.id)).flatMap((p) => [p.start, p.end]),
    ...others.flatMap((p) => [p.start, p.end]),
    now,
    endAt,
  ];
  const snapAt = (t: number, ids: string[]) => {
    const r = snapTime(t, snapMins, edgesExcept(ids), (MAGNET_PX / pxh) * HOUR);
    if (r.t !== lastSnap.current) {
      lastSnap.current = r.t;
      fx(r.edge ? "snap" : "tick");
    }
    return r.t;
  };

  const commit = (list: Plan[], ids: string[], message: string) => {
    if (overlaps(list, new Set(ids))) {
      fx("warn");
      setClash({ list, ids, message });
      return;
    }
    fx("drop");
    savePlans(editor, tid, list, message);
  };

  const togglePick = (id: string) => {
    fx("pick");
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const onDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, e.clientX);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.abs(a - b), pxh, at: (a + b) / 2 };
      setDrag(null);
      if (press.current) window.clearTimeout(press.current.timer);
      return;
    }
    const target = e.target as HTMLElement;
    const pid = target.closest<HTMLElement>("[data-plan]")?.dataset.plan;
    const t = tAt(e.clientX);
    if (pid) {
      if (e.shiftKey) return togglePick(pid);
      const p = plans.find((q) => q.id === pid)!;
      // Long-press picks it (to move several together) instead of dragging.
      press.current = { timer: window.setTimeout(() => {
        press.current = null;
        setDrag(null);
        togglePick(pid);
      }, LONG_PRESS), id: pid, x: e.clientX, y: e.clientY };
      const side = target.dataset.edge as "start" | "end" | undefined;
      lastSnap.current = 0;
      if (side) setDrag({ kind: "edge", id: pid, side, start: p.start, end: p.end });
      else {
        const ids = picked.has(pid) ? [...picked] : [pid];
        setDrag({ kind: "move", ids, grab: t - p.start, delta: 0, moved: false, origin: p.start, y: e.clientY, rows: 0 });
      }
    } else if (!target.closest(".ds-dot, .ds-form")) {
      if (!edit && e.pointerType === "touch") return;
      setDrag({ kind: "select", anchor: snapAt(t, []), at: snapAt(t, []) });
      setPicked(new Set());
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
    if (press.current && (Math.abs(e.clientX - press.current.x) > 6 || Math.abs(e.clientY - press.current.y) > 8)) {
      window.clearTimeout(press.current.timer);
      press.current = null;
      if (drag?.kind === "move" || drag?.kind === "edge") fx("pick");
    }
    if (!drag || press.current) return;
    if (drag.kind === "select") setDrag({ ...drag, at: snapAt(tAt(e.clientX), []) });
    else if (drag.kind === "move") {
      // Up or down moves it off the main line into a lane (so blocks don't sit on top of each other).
      const rows = Math.round((e.clientY - drag.y) / LANE);
      const start = Math.abs(e.clientY - drag.y) > LANE / 2 && Math.abs(tAt(e.clientX) - drag.grab - drag.origin) < (MAGNET_PX / pxh) * HOUR ? drag.origin : snapAt(tAt(e.clientX) - drag.grab, drag.ids);
      if (rows !== drag.rows) fx("tick");
      setDrag({ ...drag, delta: start - drag.origin, moved: true, rows });
    } else {
      const t = snapAt(tAt(e.clientX), [drag.id]);
      if (drag.side === "start") setDrag({ ...drag, start: Math.min(t, drag.end - snapMins * MIN) });
      else setDrag({ ...drag, end: Math.max(t, drag.start + snapMins * MIN) });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const wasPress = press.current;
    if (wasPress) window.clearTimeout(wasPress.timer);
    press.current = null;
    if (!drag) return;
    setDrag(null);
    if (drag.kind === "select") {
      const [s, en] = [Math.min(drag.anchor, drag.at), Math.max(drag.anchor, drag.at)];
      setSel({ start: s, end: en });
      setName("");
      return;
    }
    if (drag.kind === "move") {
      if (!drag.moved) {
        // A tap: open it (or, while several are picked, pick/unpick it).
        if (wasPress && picked.size) togglePick(wasPress.id);
        else if (wasPress) (fx("open"), onOpenPlan(wasPress.id));
        return;
      }
      if (!drag.delta && !drag.rows) return;
      const rowOf = (p: Plan) => Math.min(PLAN_ROWS - 1, Math.max(0, (lanes.get(p.id) ?? 0) + drag.rows));
      const list = plans.map((p) => (drag.ids.includes(p.id) ? { ...p, start: p.start + drag.delta, end: p.end + drag.delta, ...(drag.rows ? { row: rowOf(p) } : {}) } : p));
      const first = list.find((p) => p.id === drag.ids[0])!;
      if (!drag.delta) {
        fx("drop");
        savePlans(editor, tid, list, `Moved ${first.text} to ${first.row ? `lane ${first.row + 1}` : "the main line"}`);
        return;
      }
      commit(list, drag.ids, drag.ids.length > 1 ? `Moved ${drag.ids.length} plans ${drag.delta > 0 ? "+" : "−"}${hm(Math.abs(drag.delta))}` : `Moved ${first.text} to ${clock(first.start)}`);
      return;
    }
    const list = plans.map((p) => (p.id === drag.id ? { ...p, start: drag.start, end: drag.end } : p));
    const p = list.find((q) => q.id === drag.id)!;
    commit(list, [drag.id], `${p.text}: ${clock(p.start)}–${clock(p.end)} · ${hm(p.end - p.start)}`);
  };

  const shown = (p: Plan): Plan => {
    if (drag?.kind === "move" && drag.ids.includes(p.id)) return { ...p, start: p.start + drag.delta, end: p.end + drag.delta, row: Math.min(PLAN_ROWS - 1, Math.max(0, (lanes.get(p.id) ?? 0) + drag.rows)) };
    if (drag?.kind === "edge" && drag.id === p.id) return { ...p, start: drag.start, end: drag.end };
    return p;
  };
  const shownPlans = plans.map(shown);
  const shownLanes = planLanes(shownPlans);
  const deepest = Math.max(0, ...shownLanes.values());
  const selection = drag?.kind === "select" ? { start: Math.min(drag.anchor, drag.at), end: Math.max(drag.anchor, drag.at) } : sel;
  const step = pxh >= 900 ? 2 : pxh >= 360 ? 10 : pxh >= 120 ? 30 : 60; // grid minutes
  const lines: number[] = [];
  for (let t = t0; t <= t1 && lines.length < 4000; t += step * MIN) lines.push(t);
  const label = pxh >= 60 ? 1 : pxh >= 30 ? 3 : 6; // hour label every n hours
  // The floating label over the finger while dragging.
  const floating = (() => {
    if (!drag || drag.kind === "select") return null;
    const id = drag.kind === "move" ? drag.ids[0] : drag.id;
    const p = plans.find((q) => q.id === id);
    if (!p || (drag.kind === "move" && !drag.moved)) return null;
    const s = shown(p);
    return { left: x(s.start), top: 116 + (shownLanes.get(p.id) ?? 0) * LANE, text: `${clock(s.start)} → ${clock(s.end)} · ${hm(s.end - s.start)}` };
  })();

  const addPlan = () => {
    if (!sel) return;
    const len = Math.max(snapMins * MIN, sel.end - sel.start) || 30 * MIN;
    fx("drop");
    savePlans(editor, tid, [...plans, { id: randomLid(), start: sel.start, end: sel.start + len, text: name.trim() || "Plan", kind: "focus" }], `Planned ${name.trim() || "Plan"} at ${clock(sel.start)}`);
    setSel(null);
  };
  const addComment = () => {
    if (!sel) return;
    const c = { id: randomLid(), at: sel.start, text: name.trim() };
    writeBack(editor, tid, "comments", [...comments, c]);
    setSel(null);
    if (!c.text) onComment(c);
  };

  return (
    <div className="ds">
      <div className="ds-tools">
        <button type="button" onClick={() => (fx("nudge"), zoomTo(pxh / 1.6))} aria-label="Zoom out">－</button>
        <button type="button" onClick={() => (fx("nudge"), zoomTo(pxh * 1.6))} aria-label="Zoom in">＋</button>
        <span className="hint">{step} min lines</span>
        <label className="ds-snap" title="Snap while dragging">
          🧲
          <select value={snapMins} onChange={(e) => setAll(editor, tid, { snap: Number(e.target.value) })}>
            {[1, 2, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
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
        <button type="button" onClick={() => (fx("close"), onClose())} aria-label="Close" className="ds-close">✕</button>
      </div>
      <div
        ref={scroller}
        className={`ds-scroll${edit ? " editing" : ""}${drag && drag.kind !== "select" ? " dragging" : ""}`}
        onWheel={(e) => (e.ctrlKey || e.metaKey) && (e.preventDefault(), zoomTo(pxh * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX))}
      >
        <div className="ds-track" style={{ width: x(t1), height: 140 + deepest * LANE, ["--sky" as string]: sky }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
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
          {others.filter((p) => p.end > t0 && p.start < t1).map((p) => (
            <div key={`o${p.id}`} className="ds-other" style={{ left: x(p.start), width: x(p.end) - x(p.start), ["--c" as string]: p.color }} title={`${p.title}: ${p.text}`}>
              <span>{x(p.end) - x(p.start) > 50 ? p.text : ""}</span>
            </div>
          ))}
          {free.map((f, i) => (
            <div key={i} className="ds-free" style={{ left: x(f.start), width: x(f.end) - x(f.start) }}>
              {x(f.end) - x(f.start) > 44 && <span>{hm(f.end - f.start)} free</span>}
            </div>
          ))}
          {steps.filter((s) => s.at && s.at >= t0 && s.at <= t1).map((s) => (
            <span key={s.id} className={`ds-mile${s.done ? " done" : ""}`} style={{ left: x(s.at!) }} title={`${s.text} · ${clock(s.at!)}`}>🚩</span>
          ))}
          {shownPlans.map((p) => {
            const missed = !p.done && p.end <= now && !p.actual?.length;
            const moving = drag && drag.kind !== "select" && (drag.kind === "move" ? drag.ids.includes(p.id) && drag.moved : drag.id === p.id);
            return (
              <div
                key={p.id}
                data-plan={p.id}
                className={`ds-plan${p.ai ? " ai" : ""}${picked.has(p.id) ? " picked" : ""}${p.done ? " done" : ""}${missed ? " missed" : ""}${moving ? " moving" : ""}`}
                style={{ left: x(p.start), top: 84 + (shownLanes.get(p.id) ?? 0) * LANE, width: Math.max(4, x(p.end) - x(p.start)), ["--c" as string]: kindColor(p) }}
              >
                <i data-edge="start" className="ds-edge" />
                <span>{p.done ? "✓ " : ""}{p.text} <small>{clock(p.start)}–{clock(p.end)}</small></span>
                <i data-edge="end" className="ds-edge right" />
              </div>
            );
          })}
          {reminders.map((r, i) => <span key={i} className="ds-rem" style={{ left: x(r.at) }} title={r.text}>🔔{clock(r.at)}</span>)}
          {comments.map((c) => <button key={c.id} type="button" className="ds-dot" style={{ left: x(c.at) }} title={`${clock(c.at)} ${c.text}`} onClick={() => onComment(c)} />)}
          {selection && <div className="ds-sel" style={{ left: x(selection.start), width: Math.max(2, x(selection.end) - x(selection.start)) }}><small>{clock(selection.start)}–{clock(selection.end)} · {hm(selection.end - selection.start)}</small></div>}
          {now >= t0 && now <= t1 && <i className="ds-now" style={{ left: x(now) }}><small>{clock(now)}</small></i>}
          {endAt >= t0 && endAt <= t1 && <span className="ds-flag" style={{ left: x(endAt) }}>🏁</span>}
          {floating && <span className="ds-float" style={{ left: floating.left, top: floating.top }}>{floating.text}</span>}
        </div>
      </div>
      {clash && (
        <div className="ds-form ds-clash">
          <b>⚠️ That overlaps another plan</b>
          <button type="button" onClick={() => (fx("drop"), savePlans(editor, tid, clash.list, clash.message), setClash(null))}>Keep overlap</button>
          <button type="button" className="primary" onClick={() => (fx("drop"), savePlans(editor, tid, clash.ids.reduce((l, id) => pushLater(l, id), clash.list), `${clash.message}, the rest pushed later`), setClash(null))}>Push the rest later</button>
          <button type="button" onClick={() => (fx("close"), setClash(null))}>Cancel</button>
        </div>
      )}
      {picked.size > 0 && !drag && !clash && (
        <div className="ds-form">
          <b>{picked.size} picked</b>
          <span className="hint">Drag one to move them all</span>
          <button type="button" onClick={() => (fx("done"), savePlans(editor, tid, plans.map((p) => (picked.has(p.id) ? { ...p, done: true } : p)), `Ticked ${picked.size} done`), setPicked(new Set()))}>✓ Done</button>
          <button type="button" onClick={() => (fx("delete"), savePlans(editor, tid, plans.filter((p) => !picked.has(p.id)), `Deleted ${picked.size} plans`), setPicked(new Set()))} aria-label="Delete">🗑</button>
          <button type="button" onClick={() => setPicked(new Set())} aria-label="Clear">✕</button>
        </div>
      )}
      {sel && !drag && (
        <div className="ds-form">
          <b>{clock(sel.start)}{sel.end > sel.start ? `–${clock(sel.end)} · ${hm(sel.end - sel.start)}` : ""}</b>
          <input autoFocus placeholder="What goes here?" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPlan()} />
          <button type="button" onClick={addPlan}>Plan it</button>
          <button type="button" onClick={addComment}>💬</button>
          <button type="button" onClick={() => setSel(null)} aria-label="Cancel">✕</button>
        </div>
      )}
      {ai && (
        <Planner
          start={ai.start}
          end={ai.end}
          busy={busy.filter((b) => b.end > ai.start - HOUR && b.start < ai.end + HOUR)}
          plans={plans}
          prefs={String(head?.prefs ?? "")}
          onPlans={(list) => savePlans(editor, tid, list, "Planned")}
          onPrefs={(p) => setAll(editor, tid, { prefs: p })}
          onClose={() => setAi(null)}
        />
      )}
    </div>
  );
}

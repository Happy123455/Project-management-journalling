import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { journalStore } from "./attachments";
import { loadConfig, loadEntries, ROUTINE_EVENT, viewOf, type RoutineView } from "../routine/routineData";
import { addDays, dayKey } from "../lib/timestamp";
import { visibleInterval } from "../lib/power";
import { reminderTimes, timeLeft } from "../lib/reminders";
import { DeadlineStrip } from "./deadlineStrip";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { onlyTextInLines } from "./blocks";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BUILT_IN_TEMPLATES, busyOn, clock, DAY, dayLabel, firstFit, freeAcross, freeGaps, freeHint, hm, infoOf, midnight, missedPlans, needMins, parseDuration, PLAN_KINDS, progressOf, shownRange, skyGradient, templateDays, type Layer, type Plan, type Progress } from "../lib/deadline";
import { randomLid } from "../sync/lineIds";
import { fx } from "../lib/fx";
import { showToast } from "../lib/toast";
import { barsOf, deadlineRows, plansIn, plansOf, registerDeadlineEditor, savePlans, setAll, useAllDeadlines } from "./deadlineStore";
import { DeadlineSheet, savedTemplates } from "./DeadlineSheet";
import { PlanSheet } from "./PlanSheet";
import { startFocus } from "./focus";
import { noteDayOf } from "./noteEdit";

/** The week strip above each day's bar (Monday first). */
const WEEK_LETTERS = ["M", "T", "W", "Th", "F", "Sa", "Su"];

/**
 * ⏳ Deadline bar: `/deadline`, pick when it's due, and the note gets one bar per day up to then
 * (each breaks at midnight, so there's room to write between the days). A bar shows the sky's
 * colours through the day like the timestamp chips, the routine laid behind it (the phase's usual
 * day or one chosen day), the free time between with how long it is, reminders, and 💬 comments
 * dropped at a time. Settings (routine layer, waking hours only) are shared by every bar of one
 * deadline. Nothing here is computed into the note: the bars only store their day and comments.
 */

// One routine reader for every bar on screen (each reading 400 days of notes was too much).
let routine: RoutineView | null = null;
let loading = false;
const listeners = new Set<() => void>();
async function loadRoutine() {
  const store = journalStore();
  if (!store || loading) return;
  loading = true;
  try {
    const config = await loadConfig(store);
    const entries = await loadEntries(store, config, dayKey(new Date()), !!routine);
    routine = viewOf(config, entries, Date.now());
    listeners.forEach((f) => f());
  } finally {
    loading = false;
  }
}
let watching = false;
function subscribe(f: () => void) {
  listeners.add(f);
  if (!watching) {
    watching = true;
    const again = () => void loadRoutine();
    window.addEventListener(ROUTINE_EVENT, again);
    window.addEventListener("journal:synced", again);
  }
  if (!routine) void loadRoutine();
  return () => void listeners.delete(f);
}
export const useRoutineShared = () => useSyncExternalStore(subscribe, () => routine);

export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => visibleInterval(() => setNow(Date.now()), 60_000), []);
  return now;
}

interface Comment {
  id: string;
  at: number;
  text: string;
  /** Its own note (photos, files, anything), made on "Open as note". */
  page?: string;
}

/** The deadline's plans across all its bars, kept fresh on the first bar (other bars' changes don't re-render it). */
function useDeadlinePlans(editor: Editor, tid: string, on: boolean): Plan[] {
  const [plans, setPlans] = useState<Plan[]>(() => (on ? plansIn(editor, tid) : []));
  useEffect(() => {
    if (!on) return;
    let key = "";
    const read = () => {
      const list = plansIn(editor, tid);
      const k = JSON.stringify(list);
      if (k !== key) {
        key = k;
        setPlans(list);
      }
    };
    read();
    // Letters typed in a line never change a bar's plans (they're the bars' own data), so typing
    // doesn't make every bar look through the whole note on each key.
    const onUpdate = ({ transaction }: { transaction: Transaction }) => void (onlyTextInLines(transaction) || read());
    editor.on("update", onUpdate);
    return () => void editor.off("update", onUpdate);
  }, [editor, tid, on]);
  return plans;
}

function Setup({ onMake }: { onMake: (title: string, end: number, extra: Record<string, unknown>) => void }) {
  const tomorrow = addDays(dayKey(new Date()), 2);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("18:00");
  const [tpl, setTpl] = useState("");
  const [needText, setNeedText] = useState("");
  const templates = [...BUILT_IN_TEMPLATES, ...savedTemplates()];
  const end = new Date(`${date}T${time || "23:59"}`).getTime();
  const make = () => {
    const t = templates.find((x) => x.name === tpl);
    const extra: Record<string, unknown> = { need: parseDuration(needText) ?? 0 };
    if (t) Object.assign(extra, { emoji: t.emoji, color: t.color, prefs: t.prefs ?? "", steps: t.steps.map((s) => ({ id: randomLid(), text: s.text, mins: s.mins })) });
    fx("done");
    onMake(title.trim() || t?.name || "", end, extra);
  };
  return (
    <div className="dl-setup">
      <span className="dl-setup-icon">⏳</span>
      <input placeholder="What's due?" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && end > Date.now() && make()} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      <select value={tpl} onChange={(e) => (fx("tick"), setTpl(e.target.value))} aria-label="Template">
        <option value="">Blank</option>
        {templates.map((t) => <option key={t.name} value={t.name}>{t.emoji} {t.name}</option>)}
      </select>
      <input className="dl-setup-need" placeholder="Work needed (12h)" value={needText} onChange={(e) => setNeedText(e.target.value)} />
      <button type="button" className="primary" disabled={!(end > Date.now())} onClick={make}>Make</button>
    </div>
  );
}

/** Where a bar sits in its deadline (from the fold plugin below). */
interface Place {
  index: number;
  count: number;
  /** The last bar on screen: it draws the bottom edge. */
  lastShown: boolean;
  /** Days folded away under the bottom edge. */
  hidden: number;
  collapsed: boolean;
  show: number;
  /** The first bar on screen (draws the top edge): the first day, or today's in scroll mode. */
  firstShown?: boolean;
  /** Scroll mode: days above / below the ones on screen. */
  before?: number;
  after?: number;
  scroll?: boolean;
}

/** Done / planned / still needed as one soft three-part ring. */
function Ring({ p, color }: { p: Progress; color: string }) {
  const total = Math.max(p.need, p.done + p.planned, 1);
  const r = 9;
  const c = 2 * Math.PI * r;
  const done = Math.min(1, p.done / total) * c;
  const planned = Math.min(1 - done / c, p.planned / total) * c;
  return (
    <svg className="dl-ring" viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <circle cx="12" cy="12" r={r} className="dl-ring-bg" />
      <circle cx="12" cy="12" r={r} stroke={color} strokeOpacity={0.35} strokeDasharray={`${planned} ${c}`} strokeDashoffset={-done} transform="rotate(-90 12 12)" />
      <circle cx="12" cy="12" r={r} stroke={color} strokeDasharray={`${done} ${c}`} transform="rotate(-90 12 12)" />
    </svg>
  );
}

const STATUS_TEXT: Record<Progress["status"], string> = { none: "", done: "🎉 Done", ok: "On track", tight: "Tight", behind: "Behind" };

function DeadlineView({ node, editor, getPos, updateAttributes, selected, decorations }: NodeViewProps) {
  const a = node.attrs as { tid: string; day: string; endAt: number; title: string; layer: Layer; awake: boolean; comments: Comment[]; first: boolean; plans: Plan[]; prefs: string };
  const info = infoOf(node.attrs);
  const place = ((decorations as unknown as { spec?: { dl?: Place } }[]) ?? []).map((d) => d.spec?.dl).find(Boolean) ?? { index: 0, count: 1, lastShown: true, hidden: 0, collapsed: false, show: 0 };
  const top = place.firstShown ?? a.first;
  const rowRef = useRef<HTMLDivElement>(null);
  useInnerScroll(rowRef, editor, a.tid, !!place.scroll && place.hidden > 0);
  const [strip, setStrip] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  const [planOpen, setPlanOpen] = useState<string | null>(null);
  const now = useNow();
  const view = useRoutineShared();
  const all = useAllDeadlines();
  const [reminders, setReminders] = useState<{ at: number; text: string }[]>([]);
  const [menu, setMenu] = useState<{ at: number; x: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The first bar keeps every plan of the deadline (for progress); others only need theirs, until a sheet opens.
  const allPlans = useDeadlinePlans(editor, a.tid, !!a.day && (top || sheet || planOpen !== null));

  useEffect(() => (a.tid && a.day ? registerDeadlineEditor(a.tid, editor) : undefined), [a.tid, a.day, editor]);

  useEffect(() => {
    const store = journalStore();
    if (!store || !a.day) return;
    let live = true;
    const read = () =>
      void store.getDay(a.day).then((p) => {
        if (!live) return;
        const t0 = midnight(a.day);
        setReminders(reminderTimes(p?.content).map((r) => ({ at: t0 + (r.hour * 60 + r.minute) * 60_000, text: r.text })));
      });
    read();
    window.addEventListener("journal:saved", read);
    window.addEventListener("journal:synced", read);
    return () => {
      live = false;
      window.removeEventListener("journal:saved", read);
      window.removeEventListener("journal:synced", read);
    };
  }, [a.day]);

  // Plans of other open deadlines take time too.
  const others = useMemo(
    () => all.filter((t) => t.tid !== a.tid && !t.info.status).flatMap((t) => plansOf(t).map((p) => ({ ...p, color: t.info.color, title: t.title }))),
    [all, a.tid],
  );
  const busy = useMemo(() => (view && a.day ? busyOn(a.day, a.layer, view.config, view.stats, view.days) : []), [view, a.day, a.layer]);
  const [from, to] = useMemo(() => (a.day ? shownRange(a.day, busy, a.awake) : [0, 1]), [a.day, busy, a.awake]);
  const gradient = useMemo(() => (a.day ? skyGradient(from, to) : ""), [from, to, a.day]);
  const barDays = a.day && (top || sheet || planOpen) ? barsOf(editor, a.tid).map((b) => b.attrs.day as string) : [];
  const busyFor = (d: string) => (view ? busyOn(d, a.layer, view.config, view.stats, view.days) : []);
  const gapsAhead = useMemo(
    () => (barDays.length ? freeAcross(barDays, busyFor, [...allPlans, ...others], now, a.endAt) : []),
    [barDays.join(), allPlans, others, now, a.endAt, view, a.layer],
  );

  if (!a.day || !a.endAt) {
    const make = (title: string, end: number, extra: Record<string, unknown>) => {
      const pos = getPos();
      if (typeof pos !== "number") return;
      editor.chain().insertContentAt({ from: pos, to: pos + node.nodeSize }, deadlineRows(end, title, extra)).run();
    };
    return (
      <NodeViewWrapper className="dl" contentEditable={false}>
        <Setup onMake={make} />
      </NodeViewWrapper>
    );
  }

  const span = Math.max(1, to - from);
  const pct = (t: number) => `${(((Math.min(Math.max(t, from), to) - from) / span) * 100).toFixed(2)}%`;
  const width = (s: number, e: number) => `${(((Math.min(e, to) - Math.max(s, from)) / span) * 100).toFixed(2)}%`;
  const label = dayLabel(a.day);
  const t0 = midnight(a.day);
  const plans = ((a.plans ?? []) as Plan[]).filter((p) => p.end > t0 && p.start < t0 + DAY);
  const otherHere = others.filter((p) => p.end > t0 && p.start < t0 + DAY);
  const taken = [...busy, ...plans.map((p) => ({ ...p, icon: "", label: p.text })), ...otherHere.map((p) => ({ ...p, icon: "", label: p.text }))];
  const free = freeGaps(Math.max(from, now), Math.min(to, a.endAt), taken);
  const freeTotal = free.reduce((s, f) => s + f.end - f.start, 0);
  const comments = (a.comments ?? []) as Comment[];
  const due = a.endAt >= t0 && a.endAt < t0 + DAY;
  const opts = view ? templateDays(view.config, view.days, view.day) : [];
  const need = needMins(info) * 60_000;
  const progress = progressOf(allPlans, need, now, gapsAhead.reduce((s, g) => s + g.end - g.start, 0), info.status === "done");
  const missed = missedPlans(allPlans, now);
  const miles = info.steps.filter((s) => s.at && s.at >= t0 && s.at < t0 + DAY);
  const openPlan = planOpen ? allPlans.find((p) => p.id === planOpen) ?? null : null;
  const noteDay = noteDayOf(editor);
  const nextFree = (len: number, after: number, ignore: string) =>
    firstFit(freeAcross(barDays, busyFor, [...allPlans.filter((p) => p.id !== ignore), ...others], Math.max(now, after), a.endAt), len, after);

  const atX = (clientX: number, box: DOMRect) => from + ((clientX - box.left) / box.width) * span;
  const addComment = (at: number) => {
    const c: Comment = { id: randomLid(), at, text: "" };
    updateAttributes({ comments: [...comments, c].sort((x, y) => x.at - y.at) });
    setOpen(c.id);
    setMenu(null);
  };
  const editComment = (id: string, text: string) => updateAttributes({ comments: comments.map((c) => (c.id === id ? { ...c, text } : c)) });
  const commentNote = (c: Comment) => {
    const page = c.page || `💬 ${a.title || "Deadline"} · ${dayLabel(a.day).text} ${clock(c.at)}`;
    if (!c.page) updateAttributes({ comments: comments.map((x) => (x.id === c.id ? { ...x, page } : x)) });
    window.dispatchEvent(new CustomEvent("journal:open-link", { detail: page }));
  };
  const dropComment = (id: string) => {
    updateAttributes({ comments: comments.filter((c) => c.id !== id) });
    setOpen(null);
  };
  const moveMissed = () => {
    let list = allPlans.filter((p) => !missed.includes(p));
    let placed = 0;
    for (const m of missed) {
      const len = m.end - m.start;
      const at = firstFit(freeAcross(barDays, busyFor, [...list, ...others], now, a.endAt), len, now);
      if (at === null) continue;
      list = [...list, { ...m, start: at, end: at + len }];
      placed++;
    }
    if (!placed) return fx("warn"), showToast("No free time left for them before the deadline");
    list = [...list, ...missed.filter((m) => !list.some((p) => p.id === m.id))];
    fx("drop");
    savePlans(editor, a.tid, list, `Moved ${placed} missed plan${placed === 1 ? "" : "s"} to free time`);
  };
  const toggleFold = () => (fx(place.collapsed ? "open" : "close"), setAll(editor, a.tid, { collapsed: !place.collapsed }));

  return (
    <NodeViewWrapper className={`dl${selected ? " selected" : ""}${info.status ? ` is-${info.status}` : ""}`} contentEditable={false} style={{ ["--dl" as string]: info.color }}>
      {top && (
        <div className="dl-edge top">
          <button type="button" className="dl-fold-btn" onClick={toggleFold} aria-label={place.collapsed ? "Unfold" : "Fold"}>{place.collapsed ? "▸" : "▾"}</button>
          <button type="button" className="dl-name" onClick={() => (fx("open"), setSheet(true))} title="Deadline settings">
            {(need > 0 || info.status === "done") && <Ring p={progress} color={info.color} />}
            <span>{info.emoji} {a.title || "Deadline"}</span>
          </button>
          <span className="dl-left">{info.status === "done" ? "done" : a.endAt > now ? `${timeLeft(a.endAt - now)} left` : "due"}</span>
          <span className="dl-due">{new Date(a.endAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
          {!place.collapsed && (
            <span className="dl-tools">
              <select value={a.layer} onChange={(e) => (fx("tick"), setAll(editor, a.tid, { layer: e.target.value }))} aria-label="Routine layer" title="Routine behind the bars">
                <option value="off">No routine</option>
                <option value="avg">Usual day</option>
                {opts.map((d) => (
                  <option key={d} value={`day:${d}`}>Like {dayLabel(d).text}</option>
                ))}
              </select>
              <button type="button" className={a.awake ? "on" : ""} onClick={() => (fx("tick"), setAll(editor, a.tid, { awake: !a.awake }))} title="Waking hours only">🌙</button>
              <button type="button" onClick={() => (fx("open"), window.dispatchEvent(new CustomEvent("journal:timelines", { detail: { tid: a.tid } })))} title="Days side by side">⇆</button>
              <button type="button" onClick={() => (fx("open"), setSheet(true))} title="Settings, steps, AI re-plan">⚙</button>
            </span>
          )}
        </div>
      )}
      {top && !place.collapsed && (need > 0 || missed.length > 0 || info.status === "done") && (
        <div className={`dl-progress st-${progress.status}`}>
          {need > 0 && (
            <i className="dl-meter" title={`${hm(progress.done)} done · ${hm(progress.planned)} planned · ${hm(need)} needed`}>
              <b className="m-done" style={{ width: `${Math.min(100, (progress.done / Math.max(need, progress.done + progress.planned)) * 100)}%` }} />
              <b className="m-plan" style={{ width: `${Math.min(100, (progress.planned / Math.max(need, progress.done + progress.planned)) * 100)}%` }} />
            </i>
          )}
          <span className="dl-st">{STATUS_TEXT[progress.status]}</span>
          {need > 0 && <span>✓ {hm(progress.done)} · ◔ {hm(progress.planned)} · of {hm(need)}</span>}
          {progress.status !== "done" && progress.short > 0 && <span className="dl-hint">Short by {hm(progress.short)} · {freeHint(gapsAhead, now)}</span>}
          {missed.length > 0 && progress.status !== "done" && (
            <button type="button" className="dl-missed" onClick={moveMissed}>⚠ {missed.length} missed · ⇥ move to free time</button>
          )}
          {info.status === "done" && info.repeat && <button type="button" onClick={() => (fx("open"), setSheet(true))}>⟳ Next one</button>}
        </div>
      )}
      {!place.collapsed && <div ref={rowRef} className={`dl-row${label.weekend ? " weekend" : ""}`}>
        <div className="dl-week" title={label.text}>
          {WEEK_LETTERS.map((w, i) => (
            <span key={w} className={`${i >= 5 ? "we" : ""}${i === (new Date(midnight(a.day)).getDay() + 6) % 7 ? " on" : ""}`}>
              {w}{i === (new Date(midnight(a.day)).getDay() + 6) % 7 && <b>{label.text.split(" ")[1]}</b>}
            </span>
          ))}
          {freeTotal > 0 && <small>{hm(freeTotal)} free</small>}
        </div>
        <div
          className="dl-bar"
          style={{ background: gradient }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".dl-dot, .dl-pop, .dl-plan")) return;
            const box = e.currentTarget.getBoundingClientRect();
            const at = atX(e.clientX, box);
            setMenu(null);
            fx(strip === null ? "open" : "close");
            setStrip(strip === null ? at : null);
          }}
        >
          {now > from && <div className="dl-past" style={{ width: width(from, now) }} />}
          {a.endAt < to && <div className="dl-after" style={{ left: pct(a.endAt), width: width(a.endAt, to) }} />}
          {busy.map((b, i) => (
            <div key={i} className={`dl-busy${b.sleep ? " sleep" : ""}`} style={{ left: pct(b.start), width: width(b.start, b.end) }} title={`${b.label} ${clock(b.start)}–${clock(b.end)}`}>
              <span>{b.icon}</span>
            </div>
          ))}
          {otherHere.map((p) => (
            <div key={`o${p.id}`} className="dl-other" style={{ left: pct(p.start), width: width(p.start, p.end), ["--c" as string]: p.color }} title={`${p.title}: ${clock(p.start)}–${clock(p.end)} ${p.text}`} />
          ))}
          {plans.map((p) => {
            const isMissed = !p.done && p.end <= now && !p.actual?.length;
            return (
              <button
                key={p.id}
                type="button"
                className={`dl-plan${p.ai ? " ai" : ""}${p.done ? " done" : ""}${isMissed ? " missed" : ""}`}
                style={{ left: pct(p.start), width: width(p.start, p.end), ["--c" as string]: PLAN_KINDS.find((k) => k.id === (p.kind ?? "focus"))?.color }}
                title={`${clock(p.start)}–${clock(p.end)} ${p.text}`}
                onClick={(e) => {
                  e.stopPropagation();
                  fx("open");
                  setPlanOpen(p.id);
                }}
              >
                <span>{p.done ? "✓ " : ""}{p.text}</span>
              </button>
            );
          })}
          {free.map((f, i) => (
            <div key={i} className="dl-free" style={{ left: pct(f.start), width: width(f.start, f.end) }} title={`Free ${clock(f.start)}–${clock(f.end)}`}>
              {(f.end - f.start) / span > 0.09 && <span>{hm(f.end - f.start)}</span>}
            </div>
          ))}
          {[6, 12, 18].map((h) => t0 + h * 3_600_000).filter((t) => t > from && t < to).map((t) => (
            <i key={t} className="dl-tick" style={{ left: pct(t) }}><b>{clock(t).slice(0, 2)}</b></i>
          ))}
          {reminders.filter((r) => r.at >= from && r.at <= to).map((r, i) => (
            <span key={i} className="dl-rem" style={{ left: pct(r.at) }} title={`${clock(r.at)} ${r.text}`}>🔔<small>{clock(r.at)}</small></span>
          ))}
          {miles.map((s) => <span key={s.id} className={`dl-mile${s.done ? " done" : ""}`} style={{ left: pct(s.at!) }} title={`🚩 ${s.text} · ${clock(s.at!)}`}>🚩</span>)}
          {now >= from && now <= to && <i className="dl-now" style={{ left: pct(now) }} />}
          {due && <span className="dl-flag" style={{ left: pct(a.endAt) }} title={`Due ${clock(a.endAt)}`}>🏁</span>}
          {comments.filter((c) => c.at >= from && c.at <= to).map((c) => (
            <button key={c.id} type="button" className={`dl-dot${c.text ? "" : " empty"}`} style={{ left: pct(c.at) }} onClick={() => setOpen(open === c.id ? null : c.id)} title={`${clock(c.at)} ${c.text}`} />
          ))}
          {menu && (
            <div className="dl-pop dl-menu" style={{ left: Math.max(0, menu.x - 60) }}>
              <button type="button" onClick={() => addComment(menu.at)}>💬 Comment at {clock(menu.at)}</button>
              <button type="button" onClick={() => setMenu(null)}>✕</button>
            </div>
          )}
        </div>
      </div>}
      {strip !== null && !place.collapsed && (
        <DeadlineStrip
          editor={editor}
          tid={a.tid}
          endAt={a.endAt}
          layer={a.layer}
          view={view}
          now={now}
          focus={strip}
          others={others}
          steps={info.steps}
          onClose={() => setStrip(null)}
          onComment={(c) => setOpen(c.id)}
          onOpenPlan={(id) => setPlanOpen(id)}
        />
      )}
      {(place.lastShown || place.collapsed) && (place.collapsed ? a.first : true) && (
        <div className="dl-edge bottom" onPointerDown={(e) => !place.collapsed && place.count > 1 && dragEdge(e, editor, a.tid, place)}>
          {!place.collapsed && place.count > 1 && <i className="dl-grip" aria-hidden />}
          <button type="button" className="dl-fold-btn" onClick={toggleFold} aria-label={place.collapsed ? "Unfold" : "Fold"}>{place.collapsed ? "▸" : "▴"}</button>
          {place.collapsed ? (
            <span className="hint">{place.count} day{place.count === 1 ? "" : "s"} folded{info.status === "archived" ? " · archived" : ""}</span>
          ) : (
            <>
              {place.hidden > 0 && !place.scroll && <button type="button" className="link" onClick={() => (fx("open"), setAll(editor, a.tid, { show: 0 }))}>+{place.hidden} more day{place.hidden === 1 ? "" : "s"}</button>}
              {place.scroll && place.hidden > 0 && (
                <span className="dl-scroll-pos">
                  <button type="button" disabled={!place.before} onClick={() => scrollDays(editor, a.tid, -1)} aria-label="Earlier day">▲</button>
                  <button type="button" disabled={!place.after} onClick={() => scrollDays(editor, a.tid, 1)} aria-label="Later day">▼</button>
                  <button type="button" className="link" onClick={() => (fx("tick"), scrollDays(editor, a.tid, null))}>Today first</button>
                  <small>{place.before} above · {place.after} below</small>
                </span>
              )}
              {place.count > 1 && (
                <button type="button" className={`dl-scroll-toggle${place.scroll ? " on" : ""}`} title="Scroll inside: fixed height, today on the first line" onClick={() => (fx("tick"), scrollDays(editor, a.tid, null), setAll(editor, a.tid, { scroll: !place.scroll, show: !place.scroll && !place.show ? Math.min(3, place.count) : place.show }))}>
                  ↕ Scroll
                </button>
              )}
              {place.count > 1 && <span className="dl-drag-hint">hold ═ and drag to show {place.hidden ? "more" : "fewer"}</span>}
            </>
          )}
        </div>
      )}
      {comments.filter((c) => c.id === open).map((c) => (
        <div key={c.id} className="dl-comment">
          <span className="dl-comment-time">💬 {clock(c.at)}</span>
          <textarea autoFocus defaultValue={c.text} placeholder="Comment…" onBlur={(e) => e.target.value !== c.text && editComment(c.id, e.target.value)} />
          <button type="button" onClick={() => commentNote(c)} title="Open as a note (photos, files, anything)">📝</button>
          <button type="button" onClick={() => dropComment(c.id)} aria-label="Delete comment">🗑</button>
          <button type="button" onClick={() => setOpen(null)} aria-label="Close">✓</button>
        </div>
      ))}
      {sheet && (
        <DeadlineSheet editor={editor} info={info} prefs={a.prefs ?? ""} plans={allPlans} gaps={gapsAhead} now={now} onClose={() => setSheet(false)} />
      )}
      {openPlan && (
        <PlanSheet
          plan={openPlan}
          plans={allPlans}
          days={barDays}
          steps={info.steps}
          endAt={a.endAt}
          nextFree={nextFree}
          onSave={(list, message) => savePlans(editor, a.tid, list, message)}
          onFocus={(p) => startFocus({ note: noteDay, tid: a.tid, planId: p.id, title: p.text || a.title || "Focus", planEnd: p.end })}
          onClose={() => setPlanOpen(null)}
        />
      )}
    </NodeViewWrapper>
  );
}

export const DeadlineBar = Node.create({
  name: "deadlineBar",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    const json = (name: string, fallback: unknown, data = name) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => {
        try {
          return JSON.parse(el.getAttribute(`data-${data}`) ?? "null") ?? fallback;
        } catch {
          return fallback;
        }
      },
      renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${data}`]: JSON.stringify(attrs[name]) }),
    });
    return {
      tid: json("tid", ""),
      day: json("day", ""),
      endAt: json("endAt", 0, "end-at"),
      title: json("title", ""),
      layer: json("layer", "avg"),
      awake: json("awake", false),
      comments: json("comments", []),
      first: json("first", false),
      plans: json("plans", []),
      prefs: json("prefs", ""),
      collapsed: json("collapsed", false),
      show: json("show", 0),
      scroll: json("scroll", false),
      emoji: json("emoji", ""),
      color: json("color", ""),
      notes: json("notes", ""),
      need: json("need", 0),
      steps: json("steps", []),
      status: json("status", ""),
      remind: json("remind", 10),
      dueAlerts: json("dueAlerts", true, "due-alerts"),
      snap: json("snap", 5),
      repeat: json("repeat", ""),
    };
  },
  parseHTML() {
    return [{ tag: "div[data-deadline-bar]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-deadline-bar": "" })];
  },
  // Copied, searched and counted as the day and its comments.
  renderText({ node }) {
    const a = node.attrs;
    const head = a.first ? `⏳ ${a.title || "Deadline"} (due ${new Date(a.endAt).toLocaleString()})\n` : "";
    return head + `${a.day ? dayLabel(a.day).text : ""}` + (a.plans ?? []).map((p: Plan) => `\n${clock(p.start)}–${clock(p.end)} ${p.text}`).join("") + (a.comments ?? []).map((c: Comment) => `\n💬 ${clock(c.at)} ${c.text}`).join("");
  },
  addNodeView() {
    return ReactNodeViewRenderer(DeadlineView);
  },
  addProseMirrorPlugins() {
    return [foldPlugin];
  },
});

/**
 * A deadline's days fold away between its top and bottom edge lines: folded, only the top line
 * shows; with "show N days", the bars (and the writing between them) after the Nth are hidden
 * until opened again. Hidden, not removed: nothing in the note changes but two settings.
 */
type FoldUi = { off: Map<string, number>; preview: Map<string, number> };
const foldKey = new PluginKey<FoldUi>("deadlineFold");
type FoldMeta = { tid: string; scroll?: number | null; preview?: number | null };

/** Scroll mode: move the days on screen by `by` (null: back to today on the first line). */
export function scrollDays(editor: Editor, tid: string, by: number | null) {
  editor.view.dispatch(editor.state.tr.setMeta(foldKey, { tid, scroll: by } satisfies FoldMeta));
}

/** Hold the bottom edge and drag: down shows more days, up fewer (one bar's height a day). */
function dragEdge(e: ReactPointerEvent, editor: Editor, tid: string, place: Place) {
  if ((e.target as HTMLElement).closest("button, input, label")) return;
  const el = (e.currentTarget as HTMLElement).closest(".dl") as HTMLElement | null;
  const step = Math.max(36, (el?.offsetHeight ?? 60) - 20);
  const y0 = e.clientY;
  const from = place.count - place.hidden;
  let on = false;
  let n = from;
  const hold = window.setTimeout(() => ((on = true), fx("tick"), navigator.vibrate?.(15), document.documentElement.classList.add("dl-dragging")), 280);
  const set = (preview: number | null) => editor.view.dispatch(editor.state.tr.setMeta(foldKey, { tid, preview } satisfies FoldMeta));
  const move = (ev: PointerEvent) => {
    if (!on) {
      if (Math.abs(ev.clientY - y0) > 8) end(); // a scroll, not a hold
      return;
    }
    ev.preventDefault();
    const next = Math.max(1, Math.min(place.count, from + Math.round((ev.clientY - y0) / step)));
    if (next !== n) (n = next, fx("tick"), set(n));
  };
  const end = () => {
    window.clearTimeout(hold);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    document.documentElement.classList.remove("dl-dragging");
    if (!on) return;
    set(null);
    if (n !== from) setAll(editor, tid, { show: n >= place.count ? 0 : n });
  };
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

/** Scroll mode: wheel or a vertical drag on a day's bar steps through the days. */
function useInnerScroll(ref: RefObject<HTMLDivElement | null>, editor: Editor, tid: string, on: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    let wheel = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel += e.deltaY;
      if (Math.abs(wheel) < 40) return;
      scrollDays(editor, tid, wheel > 0 ? 1 : -1);
      wheel = 0;
    };
    let y: number | null = null;
    let x0 = 0;
    const onStart = (e: TouchEvent) => ((y = e.touches[0].clientY), (x0 = e.touches[0].clientX));
    const onMove = (e: TouchEvent) => {
      if (y === null) return;
      const dy = e.touches[0].clientY - y;
      if (Math.abs(e.touches[0].clientX - x0) > Math.abs(dy)) return;
      e.preventDefault();
      if (Math.abs(dy) < 34) return;
      scrollDays(editor, tid, dy < 0 ? 1 : -1);
      fx("tick");
      y = e.touches[0].clientY;
    };
    const onEnd = () => (y = null);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, [ref, editor, tid, on]);
}

const foldPlugin = new Plugin<FoldUi>({
  key: foldKey,
  state: {
    init: () => ({ off: new Map(), preview: new Map() }),
    apply(tr, v) {
      const m = tr.getMeta(foldKey) as FoldMeta | undefined;
      if (!m) return v;
      const next = { off: new Map(v.off), preview: new Map(v.preview) };
      if (m.scroll !== undefined) m.scroll === null ? next.off.delete(m.tid) : next.off.set(m.tid, (next.off.get(m.tid) ?? 0) + m.scroll);
      if (m.preview !== undefined) m.preview === null ? next.preview.delete(m.tid) : next.preview.set(m.tid, m.preview);
      return next;
    },
  },
  props: {
    decorations(state) {
      const ui = foldKey.getState(state);
      const today = dayKey(new Date());
      const groups = new Map<string, { pos: number; size: number; first: boolean; collapsed: boolean; show: number; scroll: boolean; day: string }[]>();
      const tops: { pos: number; size: number }[] = [];
      state.doc.forEach((n, pos) => {
        tops.push({ pos, size: n.nodeSize });
        if (n.type.name !== "deadlineBar" || !n.attrs.tid || !n.attrs.day) return;
        const g = groups.get(n.attrs.tid) ?? [];
        g.push({ pos, size: n.nodeSize, first: !!n.attrs.first, collapsed: !!n.attrs.collapsed, show: Number(n.attrs.show) || 0, scroll: !!n.attrs.scroll, day: String(n.attrs.day) });
        groups.set(n.attrs.tid, g);
      });
      const decos: Decoration[] = [];
      for (const [tid, bars] of groups) {
        const head = bars.find((b) => b.first) ?? bars[0];
        const count = bars.length;
        const preview = ui?.preview.get(tid);
        const shown = head.collapsed ? 1 : preview ? preview : head.show > 0 && head.show < count ? head.show : count;
        let start = 0;
        if (head.scroll && !head.collapsed && shown < count) {
          const t = bars.findIndex((b) => b.day >= today);
          const base = t < 0 ? count - shown : t;
          start = Math.max(0, Math.min(count - shown, base + (ui?.off.get(tid) ?? 0)));
        }
        const last = start + shown - 1;
        bars.forEach((b, index) => {
          const dl: Place = { index, count, lastShown: index === last, firstShown: index === start, hidden: count - shown, collapsed: head.collapsed, show: head.show, before: start, after: count - 1 - last, scroll: head.scroll && !head.collapsed };
          decos.push(Decoration.node(b.pos, b.pos + b.size, index < start || index > last ? { class: "dl-fold" } : {}, { dl }));
        });
        // Days above the window (scroll mode): their bars and the writing after them.
        if (start > 0) for (const t of tops) if (t.pos > bars[0].pos && t.pos + t.size <= bars[start].pos) decos.push(Decoration.node(t.pos, t.pos + t.size, { class: "dl-fold" }));
        if (last < count - 1) {
          // Everything after the last shown bar's own day, up to the end of the last bar.
          const from = bars[last + 1].pos;
          const lastEnd = bars[count - 1].pos + bars[count - 1].size;
          const afterShown = bars[last].pos + bars[last].size;
          for (const t of tops) if (t.pos >= afterShown && t.pos + t.size <= lastEnd && (head.collapsed || t.pos >= from)) decos.push(Decoration.node(t.pos, t.pos + t.size, { class: "dl-fold" }));
        }
      }
      return DecorationSet.create(state.doc, decos);
    },
  },
});

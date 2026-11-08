import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { journalStore } from "./attachments";
import { loadConfig, loadEntries, ROUTINE_EVENT, viewOf, type RoutineView } from "../routine/routineData";
import { addDays, dayKey } from "../lib/timestamp";
import { visibleInterval } from "../lib/power";
import { reminderTimes, timeLeft } from "../lib/reminders";
import { Planner } from "./deadlinePlanner";
import { busyOn, clock, hm, type Free, type Plan, DAY, dayLabel, daysBetween, freeGaps, midnight, shownRange, skyGradient, templateDays, type Layer } from "../lib/deadline";
import { randomLid } from "../sync/lineIds";

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
const useRoutineShared = () => useSyncExternalStore(subscribe, () => routine);

function useNow() {
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

/** Changes every bar of this deadline at once (its settings are shared). */
function setAll(editor: Editor, tid: string, attrs: Record<string, unknown>) {
  const tr = editor.state.tr;
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === "deadlineBar" && n.attrs.tid === tid) tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs });
    return n.isBlock && !n.isTextblock;
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

function Setup({ onMake }: { onMake: (title: string, end: number) => void }) {
  const tomorrow = addDays(dayKey(new Date()), 2);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("18:00");
  const end = new Date(`${date}T${time || "23:59"}`).getTime();
  return (
    <div className="dl-setup">
      <span className="dl-setup-icon">⏳</span>
      <input placeholder="What's due?" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      <button type="button" disabled={!(end > Date.now())} onClick={() => onMake(title.trim(), end)}>Make</button>
    </div>
  );
}

function DeadlineView({ node, editor, getPos, updateAttributes, selected }: NodeViewProps) {
  const a = node.attrs as { tid: string; day: string; endAt: number; title: string; layer: Layer; awake: boolean; comments: Comment[]; first: boolean; plans: Plan[]; prefs: string };
  const now = useNow();
  const view = useRoutineShared();
  const [reminders, setReminders] = useState<{ at: number; text: string }[]>([]);
  const [menu, setMenu] = useState<{ at: number; x: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [planning, setPlanning] = useState<Free | null>(null);

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

  const busy = useMemo(() => (view && a.day ? busyOn(a.day, a.layer, view.config, view.stats, view.days) : []), [view, a.day, a.layer]);
  const [from, to] = useMemo(() => (a.day ? shownRange(a.day, busy, a.awake) : [0, 1]), [a.day, busy, a.awake]);
  const gradient = useMemo(() => (a.day ? skyGradient(from, to) : ""), [from, to, a.day]);

  if (!a.day || !a.endAt) {
    const make = (title: string, end: number) => {
      const pos = getPos();
      if (typeof pos !== "number") return;
      const tid = randomLid();
      const days = daysBetween(dayKey(new Date()), dayKey(new Date(end)));
      const rows = days.flatMap((day, i) => {
        const bar = { type: "deadlineBar", attrs: { tid, day, endAt: end, title, layer: "avg", awake: false, comments: [], first: i === 0 } };
        return i < days.length - 1 ? [bar, { type: "paragraph" }] : [bar];
      });
      editor.chain().insertContentAt({ from: pos, to: pos + node.nodeSize }, rows).run();
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
  const taken = [...busy, ...plans.map((p) => ({ ...p, icon: "", label: p.text }))];
  const free = freeGaps(Math.max(from, now), Math.min(to, a.endAt), taken);
  // The whole free stretch around a tap, ignoring what's planned in it (the planner shows those).
  const stretch = (f: Free): Free => freeGaps(Math.max(from, now), Math.min(to, a.endAt), busy).find((g) => g.start <= f.start && g.end >= f.end) ?? f;
  const freeTotal = free.reduce((s, f) => s + f.end - f.start, 0);
  const comments = (a.comments ?? []) as Comment[];
  const due = a.endAt >= t0 && a.endAt < t0 + DAY;
  const opts = view ? templateDays(view.config, view.days, view.day) : [];

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

  return (
    <NodeViewWrapper className={`dl${selected ? " selected" : ""}`} contentEditable={false}>
      {a.first && (
        <div className="dl-head">
          <strong>⏳ {a.title || "Deadline"}</strong>
          <span className="dl-left">{a.endAt > now ? `${timeLeft(a.endAt - now)} left` : "due"}</span>
          <span className="dl-due">{new Date(a.endAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
          <select value={a.layer} onChange={(e) => setAll(editor, a.tid, { layer: e.target.value })} aria-label="Routine layer">
            <option value="off">Routine off</option>
            <option value="avg">Usual day (this phase)</option>
            {opts.map((d) => (
              <option key={d} value={`day:${d}`}>Like {dayLabel(d).text}</option>
            ))}
          </select>
          <button type="button" className={a.awake ? "on" : ""} onClick={() => setAll(editor, a.tid, { awake: !a.awake })} title="Waking hours only">🌙</button>
        </div>
      )}
      <div className={`dl-row${label.weekend ? " weekend" : ""}`}>
        <div className="dl-day">
          <span>{label.text}</span>
          {freeTotal > 0 && <small>{hm(freeTotal)} free</small>}
        </div>
        <div
          className="dl-bar"
          style={{ background: gradient }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".dl-dot, .dl-pop, .dl-free")) return;
            const box = e.currentTarget.getBoundingClientRect();
            const at = Math.round(atX(e.clientX, box) / 300_000) * 300_000;
            setMenu({ at, x: e.clientX - box.left });
          }}
        >
          {now > from && <div className="dl-past" style={{ width: width(from, now) }} />}
          {a.endAt < to && <div className="dl-after" style={{ left: pct(a.endAt), width: width(a.endAt, to) }} />}
          {busy.map((b, i) => (
            <div key={i} className={`dl-busy${b.sleep ? " sleep" : ""}`} style={{ left: pct(b.start), width: width(b.start, b.end) }} title={`${b.label} ${clock(b.start)}–${clock(b.end)}`}>
              <span>{b.icon}</span>
            </div>
          ))}
          {plans.map((p) => (
            <div key={p.id} className={`dl-plan${p.ai ? " ai" : ""}`} style={{ left: pct(p.start), width: width(p.start, p.end) }} title={`${clock(p.start)}–${clock(p.end)} ${p.text}`}>
              <span>{p.text}</span>
            </div>
          ))}
          {free.map((f, i) => (
            <div key={i} className="dl-free" onClick={(e) => (e.stopPropagation(), setMenu(null), setPlanning(stretch(f)))} style={{ left: pct(f.start), width: width(f.start, f.end) }} title={`Free ${clock(f.start)}–${clock(f.end)}`}>
              {(f.end - f.start) / span > 0.09 && <span>{hm(f.end - f.start)}</span>}
            </div>
          ))}
          {[6, 12, 18].map((h) => t0 + h * 3_600_000).filter((t) => t > from && t < to).map((t) => (
            <i key={t} className="dl-tick" style={{ left: pct(t) }}><b>{clock(t).slice(0, 2)}</b></i>
          ))}
          {reminders.filter((r) => r.at >= from && r.at <= to).map((r, i) => (
            <span key={i} className="dl-rem" style={{ left: pct(r.at) }} title={`${clock(r.at)} ${r.text}`}>🔔<small>{clock(r.at)}</small></span>
          ))}
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
      </div>
      {comments.filter((c) => c.id === open).map((c) => (
        <div key={c.id} className="dl-comment">
          <span className="dl-comment-time">💬 {clock(c.at)}</span>
          <textarea autoFocus defaultValue={c.text} placeholder="Comment…" onBlur={(e) => e.target.value !== c.text && editComment(c.id, e.target.value)} />
          <button type="button" onClick={() => commentNote(c)} title="Open as a note (photos, files, anything)">📝</button>
          <button type="button" onClick={() => dropComment(c.id)} aria-label="Delete comment">🗑</button>
          <button type="button" onClick={() => setOpen(null)} aria-label="Close">✓</button>
        </div>
      ))}
      {planning && (
        <Planner
          start={planning.start}
          end={planning.end}
          busy={busy.filter((b) => b.end > planning.start - 3_600_000 && b.start < planning.end + 3_600_000)}
          plans={(a.plans ?? []) as Plan[]}
          prefs={a.prefs ?? ""}
          onPlans={(next) => updateAttributes({ plans: next })}
          onPrefs={(p) => setAll(editor, a.tid, { prefs: p })}
          onClose={() => setPlanning(null)}
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
});

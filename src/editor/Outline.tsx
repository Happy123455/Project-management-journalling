import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TIMESTAMP_RE } from "../lib/timestamp";
import { foldRange, indentOf } from "./blocks";
import { setTimeRail, useStamps, useTimeRail } from "./TimeRail";
import { formatGap } from "../lib/timeGaps";
import { journalStore } from "./attachments";
import { useRoutine } from "../routine/routineData";
import { agendaAction, useTodayAgenda } from "../routine/agenda";
import { DayTimeline } from "../routine/DayTimeline";
import { useEscapeToClose } from "../ui/useEscapeToClose";

/** Outline → 📅 Day: the day's timeline (routine, reminders, now) instead of the note's parts. */
function DayView({ day }: { day: string }) {
  const store = journalStore();
  const { view } = useRoutine(store);
  const { items } = useTodayAgenda(store);
  if (!store) return null;
  if (!view) return <p className="loading">Loading…</p>;
  return <DayTimeline scrollToNow view={view} day={day} agenda={day === view.day ? items : []} onReminder={(item) => !item.done && void agendaAction(store, item, "done")} />;
}

const DAY_VIEW_KEY = "journal.outlineDay";

export interface OutlineItem {
  /** Position in the note (the block's start), to jump to. */
  pos: number;
  label: string;
  icon: string;
  /** How far in it's drawn: heading level, or nesting under the heading above. */
  depth: number;
  kind: "heading" | "box" | "code" | "prompt" | "link" | "divider" | "quote" | "tasks" | "media" | "log";
  /** Folded in the note (it opens when tapped). */
  folded?: boolean;
}

const cleanLabel = (s: string) =>
  s
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => b || a)
    .replace(TIMESTAMP_RE, "")
    .replace(/\s+/g, " ")
    .trim();

/** Headings, boxes, code, prompts, link cards, dividers, quotes, task lists, media and log lines of a note. */
export function outlineOf(doc: PMNode): OutlineItem[] {
  const items: OutlineItem[] = [];
  let level = 0; // the heading we're under
  let pos = 0;
  doc.forEach((node, offset, index) => {
    pos = offset;
    const under = level + indentOf(node);
    const text = node.textContent;
    const folded = !!node.attrs.collapsed;
    switch (node.type.name) {
      case "heading": {
        const l = Number(node.attrs.level ?? 1);
        items.push({ pos, label: cleanLabel(text) || "Heading", icon: `H${l}`, depth: l - 1 + indentOf(node), kind: "heading", folded });
        level = l;
        return;
      }
      case "codeBlock":
        items.push({ pos, label: text.split("\n")[0].slice(0, 60) || "Code", icon: "</>", depth: under, kind: "code", folded });
        return;
      case "mathBlock":
        items.push({ pos, label: String(node.attrs.latex || "Math").slice(0, 60), icon: "∑", depth: under, kind: "code" });
        return;
      case "promptBlock":
        items.push({ pos, label: String(node.attrs.title || "Prompt"), icon: "🧩", depth: under, kind: "prompt", folded });
        return;
      case "linkCard":
        items.push({ pos, label: String(node.attrs.title || node.attrs.url), icon: "🔗", depth: under, kind: "link" });
        return;
      case "horizontalRule":
        items.push({ pos, label: "", icon: "—", depth: 0, kind: "divider" });
        level = 0;
        return;
      case "blockquote":
        items.push({ pos, label: cleanLabel(text).slice(0, 60) || "Quote", icon: "❝", depth: under, kind: "quote" });
        return;
      case "taskList": {
        let done = 0;
        node.forEach((item) => void (item.attrs.checked && done++));
        items.push({ pos, label: `${cleanLabel(node.firstChild?.textContent ?? "")} · ${done}/${node.childCount} done`, icon: "☑", depth: under, kind: "tasks" });
        return;
      }
    }
    // A [[Project]] line with lines under it: a box.
    if (node.isTextblock && /\[\[[^\]]+\]\]/.test(text) && foldRange(doc, index).end > index + 1) {
      items.push({ pos, label: cleanLabel(text) || "Box", icon: "📦", depth: under, kind: "box", folded });
    } else if (node.isTextblock && new RegExp(`^\\s*(?:✎ )?${TIMESTAMP_RE.source}`).test(text)) {
      const m = /\((\d{2}):(\d{2})/.exec(text);
      items.push({ pos, label: `${m ? `${m[1]}:${m[2]} ` : ""}${cleanLabel(text).slice(0, 50)}`, icon: "🕒", depth: under, kind: "log" });
    }
    // Photos, GIFs and clips sitting in the text.
    node.descendants((child, at) => {
      if (child.type.name === "attachmentImage" || child.type.name === "attachmentMedia" || child.type.name === "youtubeEmbed") {
        const name = String(child.attrs.name ?? child.attrs.url ?? "");
        const icon = child.type.name === "youtubeEmbed" ? "▶" : /^(gif|meme|greenscreen)-/.test(name) ? "🎞" : child.attrs.kind === "audio" ? "🎙" : child.attrs.kind === "pdf" ? "📕" : child.attrs.kind === "video" ? "🎥" : "🖼";
        items.push({ pos: offset + 1 + at, label: name.replace(/^(gif|meme|greenscreen|sound)-/, "").replace(/\.\w+$/, "").replace(/[-_]/g, " "), icon, depth: under, kind: "media" });
      }
    });
  });
  return items;
}

/** Scrolls the note to a spot (opening what's folded over it) and flashes it, without opening the keyboard. */
export function jumpTo(editor: Editor, pos: number, unfold: (editor: Editor, pos: number) => void) {
  unfold(editor, pos);
  requestAnimationFrame(() => {
    let el: HTMLElement | null = null;
    try {
      const dom = editor.view.nodeDOM(pos) ?? editor.view.domAtPos(pos + 1).node;
      el = (dom instanceof HTMLElement ? dom : dom?.parentElement) ?? null;
    } catch {
      el = null;
    }
    if (!el) return;
    const r = el.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + r.top - window.innerHeight * 0.3, behavior: "smooth" });
    el.classList.remove("outline-flash");
    void el.offsetWidth;
    el.classList.add("outline-flash");
    window.setTimeout(() => el?.classList.remove("outline-flash"), 1600);
  });
}

/** Obsidian-style outline: a panel listing the note's parts; tap one to go there. */
export function OutlinePanel({ editor, onJump, onClose, day }: { editor: Editor; onJump: (pos: number) => void; onClose: () => void; day?: string }) {
  const [items, setItems] = useState(() => outlineOf(editor.state.doc));
  const [dayView, setDayViewState] = useState(() => {
    try {
      return !!day && localStorage.getItem(DAY_VIEW_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setDayView = (on: boolean) => {
    setDayViewState(on);
    try {
      localStorage.setItem(DAY_VIEW_KEY, on ? "1" : "0");
    } catch {
      // This session only.
    }
  };
  const [filter, setFilter] = useState("");
  useEscapeToClose(onClose);
  useEffect(() => {
    const update = () => setItems(outlineOf(editor.state.doc));
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor]);
  // 🕒 Time: only the timestamps, with how long passed between each one and the next, and the
  // time rail on the right edge of the note.
  const time = useTimeRail();
  const stamps = useStamps(editor, time);
  const q = filter.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
  const shownStamps = q ? stamps.filter((s) => s.label.toLowerCase().includes(q)) : stamps;
  const clock = (t: number) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const span = stamps.length > 1 ? Math.max(...stamps.map((s) => s.time)) - Math.min(...stamps.map((s) => s.time)) : 0;
  return createPortal(
    <>
      <div className="outline-backdrop" onClick={onClose} />
      <aside className={time ? "outline-panel with-rail" : "outline-panel"} role="dialog" aria-label="Outline">
        <header>
          <strong>Outline</strong>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter the outline" />
          {day && (
            <button type="button" className={dayView ? "outline-time active" : "outline-time"} aria-pressed={dayView} title="Day: the day's timeline, with a now pointer" onClick={() => setDayView(!dayView)}>
              📅
            </button>
          )}
          <button
            type="button"
            className={time && !dayView ? "outline-time active" : "outline-time"}
            aria-pressed={time && !dayView}
            title="Time: only timestamps, with the time between them and a time rail on the right edge"
            onClick={() => {
              if (dayView) setDayView(false);
              setTimeRail(dayView ? true : !time);
            }}
          >
            🕒
          </button>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {dayView && day ? (
          <DayView day={day} />
        ) : time ? (
          <>
            {stamps.length > 1 && <p className="outline-span">{formatGap(span)} from the first to the last timestamp</p>}
            {shownStamps.length === 0 && <p className="hint">No timestamps in this note yet.</p>}
            <ul>
              {shownStamps.map((s, i) => {
                const prev = shownStamps[i - 1];
                const gap = prev ? s.time - prev.time : 0;
                return (
                  <li key={`t-${s.pos}`} className="outline-stamp">
                    {prev && (
                      <span className="outline-gap" title={gap < 0 ? "Earlier than the timestamp above it" : "Time passed since the one above"}>
                        {gap < 0 ? `↑ ${formatGap(gap)} earlier` : `↓ ${formatGap(gap)}`}
                      </span>
                    )}
                    <button type="button" onClick={() => onJump(s.pos)}>
                      <span className="outline-icon">🕒</span>
                      <span className="outline-time-at">{clock(s.time)}</span>
                      <span className="outline-label">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            {shown.length === 0 && <p className="hint">Nothing to list yet: headings, boxes, code, links, media and timed log lines show up here.</p>}
            <ul>
              {shown.map((item, i) => (
                <li key={`${item.pos}-${i}`} className={`outline-${item.kind}`} style={{ paddingLeft: `${8 + Math.min(item.depth, 6) * 14}px` }}>
                  {item.kind === "divider" ? (
                    <hr />
                  ) : (
                    <button type="button" onClick={() => onJump(item.pos)}>
                      <span className="outline-icon">{item.icon}</span>
                      <span className="outline-label">{item.label}</span>
                      {item.folded && <span className="outline-folded" title="Folded: opens when you tap it">▸</span>}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </>,
    document.body,
  );
}

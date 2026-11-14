import { useEffect, useRef, useState, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/react";
import type { JournalStore } from "../store";
import { blockRows, type Section } from "./blocks";
import { dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { haptic } from "../lib/haptic";
import { parseSheet, sheetText } from "../lib/sheet";

/**
 * 📍 Picking the part of a note the AI may change: the note as you'd read it, and you drag a finger
 * (or the mouse) down its lines to light them up. On a phone, hold a moment and then drag (a plain
 * swipe still scrolls); a tap on a line also picks it, a second tap picks everything in between.
 */

const HOLD_MS = 220;

function inlineText(n: JSONContent): string {
  return docText(n).replace(/\n+/g, " ").trim();
}

/** One top-level block, read-only, looking like the note. */
function ReadBlock({ node }: { node: JSONContent }): ReactNode {
  const t = node.type;
  if (t === "heading") {
    const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 2)));
    return <div className={`lp-h lp-h${level}`}>{inlineText(node) || " "}</div>;
  }
  if (t === "bulletList" || t === "orderedList" || t === "taskList") {
    return (
      <ul className={`lp-list ${t}`}>
        {(node.content ?? []).map((li, i) => (
          <li key={i}>
            {t === "taskList" && <span className="lp-check">{li.attrs?.checked ? "☑" : "☐"}</span>}
            {t === "orderedList" && <span className="lp-num">{i + 1}.</span>}
            {inlineText(li)}
          </li>
        ))}
      </ul>
    );
  }
  if (t === "codeBlock") return <pre className="lp-code">{docText(node)}</pre>;
  if (t === "blockquote") return <blockquote className="lp-quote">{inlineText(node)}</blockquote>;
  if (t === "horizontalRule") return <hr />;
  if (t === "sheetBlock") return <pre className="lp-code lp-sheet">▦ {sheetText(parseSheet(node.attrs?.data)) || "(empty table)"}</pre>;
  if (t === "mathBlock") return <div className="lp-p lp-math">∑ {String(node.attrs?.latex ?? "")}</div>;
  const text = inlineText(node);
  if (!text && t !== "paragraph") return <div className="lp-p lp-media">({t})</div>;
  return <p className="lp-p">{text || " "}</p>;
}

export function LinePicker({ store, current, onPick, onClose }: { store: JournalStore; current?: Section | null; onPick: (s: Section | null) => void; onClose: () => void }) {
  const [day, setDay] = useState(current?.day ?? (current?.title ? "" : dayKey(new Date())));
  const [title, setTitle] = useState(current?.title ?? "");
  const [nodes, setNodes] = useState<JSONContent[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const press = useRef<{ i: number; x: number; y: number; timer: number; mouse: boolean } | null>(null);
  const anchor = useRef(-1);
  const lastTap = useRef(-1);

  useEffect(() => {
    let live = true;
    void (async () => {
      const doc = title ? (await store.getPage(title))?.content : (await store.getDay(day))?.content;
      if (!live) return;
      const rows = blockRows(doc ?? null);
      setNodes(doc?.content ?? []);
      setIds(rows.map((r) => r.id));
      const picked = current ? rows.map((x, i) => (current.ids.includes(x.id) ? i : -1)).filter((i) => i >= 0) : [];
      setRange(picked.length ? [picked[0], picked[picked.length - 1]] : null);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, day, title]);

  const indexAt = (x: number, y: number): number => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-i]");
    return el ? Number(el.dataset.i) : -1;
  };

  // While selecting, the finger moves the selection, not the page (and the list scrolls at its edges).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let frame = 0;
    const edge = (y: number) => {
      const r = el.getBoundingClientRect();
      const d = y < r.top + 40 ? -8 : y > r.bottom - 40 ? 8 : 0;
      cancelAnimationFrame(frame);
      if (d) frame = requestAnimationFrame(() => (el.scrollTop += d));
    };
    const onMove = (e: TouchEvent) => {
      const p = press.current;
      const t = e.touches[0];
      if (!p || !t) return;
      if (!selectingRef.current) {
        // Moved before the hold: it's a scroll.
        if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > 8) {
          window.clearTimeout(p.timer);
          press.current = null;
        }
        return;
      }
      e.preventDefault();
      const i = indexAt(t.clientX, t.clientY);
      if (i >= 0) setRange([Math.min(anchor.current, i), Math.max(anchor.current, i)]);
      edge(t.clientY);
    };
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      el.removeEventListener("touchmove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);
  const selectingRef = useRef(false);
  selectingRef.current = selecting;

  const startSelect = (i: number) => {
    anchor.current = i;
    setRange([i, i]);
    setSelecting(true);
    haptic("tick", 0.5);
  };
  const onDown = (e: React.PointerEvent, i: number) => {
    if (e.pointerType === "mouse") {
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.shiftKey && range) {
        anchor.current = range[0];
        setRange([Math.min(range[0], i), Math.max(range[0], i)]);
      } else startSelect(i);
      press.current = { i, x: e.clientX, y: e.clientY, timer: 0, mouse: true };
      return;
    }
    const timer = window.setTimeout(() => press.current && startSelect(i), HOLD_MS);
    press.current = { i, x: e.clientX, y: e.clientY, timer, mouse: false };
  };
  const onMouseMove = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || !selecting || !(e.buttons & 1)) return;
    const i = indexAt(e.clientX, e.clientY);
    if (i >= 0) setRange([Math.min(anchor.current, i), Math.max(anchor.current, i)]);
  };
  const onUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (p) window.clearTimeout(p.timer);
    if (selecting) {
      setSelecting(false);
      return;
    }
    // A tap (no hold, no scroll): picks the line; a second tap picks everything in between.
    if (p && !p.mouse && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) {
      if (lastTap.current >= 0 && range && range[0] === range[1] && range[0] === lastTap.current && p.i !== lastTap.current) {
        setRange([Math.min(lastTap.current, p.i), Math.max(lastTap.current, p.i)]);
        lastTap.current = -1;
      } else {
        setRange([p.i, p.i]);
        lastTap.current = p.i;
      }
    }
  };

  const use = () => {
    if (!range) return;
    const [a, b] = range;
    const name = title || (day === dayKey(new Date()) ? "Today" : day);
    const short = (n: JSONContent | undefined) => (n ? inlineText(n) || n.type || "" : "").slice(0, 24);
    onPick({ ...(title ? { title } : { day }), ids: ids.slice(a, b + 1), label: `${name} · ${short(nodes[a])}${b > a ? ` → ${short(nodes[b])}` : ""}` });
  };
  const count = range ? range[1] - range[0] + 1 : 0;

  return (
    <div className="ai-section">
      <div className="ai-chat-bar">
        <input type="date" value={day} onChange={(e) => (setDay(e.target.value), setTitle(""))} aria-label="Day" />
        <input value={title} placeholder="or a page title" onChange={(e) => setTitle(e.target.value)} aria-label="Page" />
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <p className="hint">Drag down the lines the AI may change (on a phone: hold, then drag). Tap a line, then another, to pick everything between.</p>
      <div ref={box} className={`lp-read${selecting ? " selecting" : ""}`} onPointerMove={onMouseMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()}>
        {!nodes.length && <p className="hint">Nothing written here yet.</p>}
        {nodes.map((n, i) => (
          <div key={ids[i] ?? i} data-i={i} className={`lp-block${range && i >= range[0] && i <= range[1] ? " picked" : ""}${range && i === range[0] ? " first" : ""}${range && i === range[1] ? " last" : ""}`} onPointerDown={(e) => onDown(e, i)}>
            <ReadBlock node={n} />
          </div>
        ))}
      </div>
      <div className="ai-summaries">
        <button type="button" disabled={!range} onClick={use}>📍 Use {count ? `these ${count} line${count === 1 ? "" : "s"}` : "the picked lines"}</button>
        <button type="button" onClick={() => onPick(null)}>Whole journal</button>
      </div>
    </div>
  );
}

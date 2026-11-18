import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/**
 * The agent at work, as if someone were driving the phone (Hapi, 17 Nov): while it thinks, three
 * arrow cursors circle its bubble; when it does something, they fly out to that place on the
 * screen (the line it writes, the tab it opens, the note it reads) and click and type there;
 * when it's done they fly off. Drawn only while a job runs, transforms only (cheap to animate).
 */

export const CURSOR_EVENT = "journal:agent-cursor";

export type CursorPhase = "think" | "act" | "done";
export interface CursorMsg {
  /** Which agent (its actor name). */
  key: string;
  phase: CursorPhase;
  /** think: where its bubble or panel is (a CSS selector). */
  anchor?: string;
  /** act: the tool, and words it writes (to find the line on screen). */
  tool?: string;
  text?: string;
}

export function cursorFx(m: CursorMsg) {
  window.dispatchEvent(new CustomEvent<CursorMsg>(CURSOR_EVENT, { detail: m }));
}

const READS = /^(read_|find_|search|day_list|usage_counts|math_find|pocket_status|list_|get_|open_note)/;

type Pt = { x: number; y: number };
interface Run {
  key: string;
  phase: CursorPhase;
  anchor: string;
  /** Where each of the three arrows is headed (null: orbiting the anchor). */
  to: (Pt | null)[];
  /** "click" | "type" | "scan" per arrow. */
  act: string[];
  n: number;
}

const visible = (r: DOMRect) => r.bottom > 40 && r.top < window.innerHeight - 40 && r.width > 0;
const clampPt = (p: Pt): Pt => ({ x: Math.min(window.innerWidth - 24, Math.max(12, p.x)), y: Math.min(window.innerHeight - 60, Math.max(56, p.y)) });

/** The spot on screen a tool works on. */
function targetFor(tool: string, text: string): Pt[] {
  const pm = document.querySelector<HTMLElement>(".editor .ProseMirror, .ProseMirror");
  if (tool === "open" || tool === "open_note") {
    const tab = document.querySelector<HTMLElement>(".tabs-bar, .page-tabs, header .day-title, header h1");
    const r = tab?.getBoundingClientRect();
    if (r && visible(r)) return [{ x: r.left + r.width / 2, y: r.top + r.height / 2 }, { x: r.left + 20, y: r.bottom }, { x: r.right - 20, y: r.bottom }];
  }
  if (pm) {
    const kids = [...pm.children] as HTMLElement[];
    const want = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
    let el = want ? kids.find((k) => k.textContent?.toLowerCase().includes(want)) : undefined;
    if (!el && !READS.test(tool)) el = [...kids].reverse().find((k) => visible(k.getBoundingClientRect()) && k.textContent?.trim()) ?? kids[kids.length - 1];
    if (el && !READS.test(tool)) {
      const r = el.getBoundingClientRect();
      const y = Math.min(Math.max(r.top + Math.min(r.height, 40) / 2, 70), window.innerHeight - 90);
      return [clampPt({ x: r.left + Math.min(r.width, 260) * 0.7, y }), clampPt({ x: r.left + 14, y: y + 4 }), clampPt({ x: r.left + Math.min(r.width, 260) * 0.35, y: y + 18 })];
    }
    // Reading: the arrows sweep over the note.
    const r = pm.getBoundingClientRect();
    const top = Math.max(r.top, 90);
    const bottom = Math.min(r.bottom, window.innerHeight - 120);
    const mid = (top + bottom) / 2;
    return [clampPt({ x: r.left + r.width * 0.8, y: top + 30 }), clampPt({ x: r.left + 24, y: mid }), clampPt({ x: r.left + r.width * 0.5, y: bottom - 20 })];
  }
  return [{ x: window.innerWidth / 2, y: window.innerHeight / 3 }, { x: window.innerWidth / 3, y: window.innerHeight / 2 }, { x: (window.innerWidth * 2) / 3, y: window.innerHeight / 2 }];
}

function anchorPt(sel: string): Pt {
  const el = sel ? document.querySelector<HTMLElement>(sel) : null;
  const r = el?.getBoundingClientRect();
  if (r && r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  return { x: window.innerWidth - 40, y: window.innerHeight - 90 };
}

const reduced = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

export function AgentCursors() {
  const [runs, setRuns] = useState<Run[]>([]);
  const timers = useRef(new Map<string, number>());
  const [, tick] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      const m = (e as CustomEvent<CursorMsg>).detail;
      if (!m?.key || reduced()) return;
      const t = timers.current;
      window.clearTimeout(t.get(m.key));
      setRuns((list) => {
        const cur = list.find((r) => r.key === m.key);
        const rest = list.filter((r) => r.key !== m.key);
        if (m.phase === "think") return [...rest, { key: m.key, phase: "think", anchor: m.anchor ?? cur?.anchor ?? "", to: [null, null, null], act: ["", "", ""], n: (cur?.n ?? 0) + 1 }];
        if (!cur) return list;
        if (m.phase === "done") return [...rest, { ...cur, phase: "done", n: cur.n + 1 }];
        const tool = m.tool ?? "";
        const kind = READS.test(tool) ? "scan" : tool === "open" ? "click" : "type";
        return [...rest, { ...cur, phase: "act", to: targetFor(tool, m.text ?? ""), act: [kind === "scan" ? "scan" : "click", kind, kind], n: cur.n + 1 }];
      });
      if (m.phase === "act") {
        // A write is drawn after the note reloads: look again for the line once it's there.
        if (!READS.test(m.tool ?? "") && m.text) window.setTimeout(() => setRuns((list) => list.map((r) => (r.key === m.key && r.phase === "act" ? { ...r, to: targetFor(m.tool ?? "", m.text ?? "") } : r))), 420);
        // Nothing more for a while: back to circling (still thinking).
        t.set(m.key, window.setTimeout(() => setRuns((list) => list.map((r) => (r.key === m.key && r.phase === "act" ? { ...r, phase: "think", to: [null, null, null], n: r.n + 1 } : r))), 1800));
      }
      if (m.phase === "done") t.set(m.key, window.setTimeout(() => setRuns((list) => list.filter((r) => r.key !== m.key)), 900));
    };
    window.addEventListener(CURSOR_EVENT, on);
    // The bubble can be dragged and the page scrolls: follow the anchor while something runs.
    const follow = () => tick((n) => n + 1);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener(CURSOR_EVENT, on);
      window.removeEventListener("resize", follow);
    };
  }, []);
  if (!runs.length) return null;
  return createPortal(
    <div className="agent-cursors" aria-hidden>
      {runs.map((r) => {
        const a = anchorPt(r.anchor);
        return (
          <div key={r.key} className={`ac-run ac-${r.phase}`} style={{ "--ax": `${a.x}px`, "--ay": `${a.y}px` } as CSSProperties}>
            {[0, 1, 2].map((i) => {
              const to = r.to[i];
              const out = r.phase === "done";
              // Off the screen, away from the bubble, when done.
              const gone = { x: a.x + Math.cos((i * 2 * Math.PI) / 3 - 0.6) * 900, y: a.y + Math.sin((i * 2 * Math.PI) / 3 - 0.6) * 900 };
              const p = out ? gone : to;
              return (
                <span
                  key={i}
                  className={`ac-arrow ac-${i}${p ? " away" : ""}${to && !out ? ` do-${r.act[i]}` : ""}`}
                  style={(p ? { transform: `translate3d(${p.x}px, ${p.y}px, 0)`, transitionDelay: `${i * 90}ms` } : { "--i": i }) as CSSProperties}
                >
                  <span className="ac-orbit" style={{ "--i": i } as CSSProperties}>
                    <svg viewBox="0 0 24 24" width="22" height="22">
                      <path d="M4 2 L4 19 L8.6 14.8 L11.6 21.6 L14.6 20.3 L11.7 13.6 L18 13.4 Z" />
                    </svg>
                  </span>
                  <i className="ac-ring" key={`${r.n}-${i}`} />
                </span>
              );
            })}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

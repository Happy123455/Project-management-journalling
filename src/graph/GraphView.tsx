import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { JournalStore } from "../store";
import { buildGraph, forceStep, treeLayout, type Graph, type GraphNode, type Point } from "./graph";
import { dayColor } from "../lib/projectDays";

type Layout = "web" | "tree";

const PAGE_COLOR = "rgb(167, 112, 255)";
const TAG_COLOR = "rgb(245, 158, 11)";

const radius = (n: GraphNode) => (n.kind === "day" ? 5 : 7 + Math.min(n.degree, 12) * 1.2);
const colorOf = (n: GraphNode) => (n.kind === "day" ? dayColor(n.day!) : n.kind === "tag" ? TAG_COLOR : PAGE_COLOR);

/** Pages, people and tags linked from days, as a web or as a tree that grows over time. */
export function GraphView({ store, onClose, onOpen }: {
  store: JournalStore;
  onClose: () => void;
  onOpen: (node: GraphNode) => void;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [layout, setLayout] = useState<Layout>("web");
  const days = useMemo(() => (graph ? [...new Set(graph.nodes.filter((n) => n.day).map((n) => n.day!))].sort() : []), [graph]);
  const [upTo, setUpTo] = useState(0); // index into days: the time-lapse slider
  const [playing, setPlaying] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const pos = useRef(new Map<string, Point>());
  const target = useRef(new Map<string, Point>());
  const vel = useRef(new Map<string, Point>());
  const settled = useRef(false);
  const frame = useRef(0);
  const fitted = useRef(false);

  /** Zoom and centre so all these points are on screen. */
  const fit = (points: Point[]) => {
    const el = canvas.current;
    if (!el || !points.length) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs) + 120;
    const h = Math.max(...ys) - Math.min(...ys) + 120;
    const scale = Math.min(2, Math.max(0.2, Math.min(el.clientWidth / w, el.clientHeight / h)));
    view.current = { scale, x: -((Math.min(...xs) + Math.max(...xs)) / 2) * scale, y: -((Math.min(...ys) + Math.max(...ys)) / 2) * scale };
    fitted.current = true;
  };

  useEffect(() => {
    store.graphLinks().then((links) => {
      const g = buildGraph(links);
      g.nodes.forEach((n, i) => pos.current.set(n.id, { x: Math.cos(i * 2.4) * (40 + i * 3), y: Math.sin(i * 2.4) * (40 + i * 3) }));
      setGraph(g);
    });
  }, [store]);
  useEffect(() => setUpTo(Math.max(0, days.length - 1)), [days.length]);

  // Tree positions are fixed targets the nodes glide to; the web is a live force layout.
  useEffect(() => {
    if (!graph) return;
    settled.current = false;
    target.current = layout === "tree" ? treeLayout(graph) : new Map();
    fitted.current = false;
    if (layout === "tree") fit([...target.current.values()]);
  }, [graph, layout]);

  // Play: step the slider forward through the days.
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      setUpTo((i) => {
        if (i >= days.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, Math.max(60, 2400 / Math.max(days.length, 1)));
    return () => window.clearInterval(t);
  }, [playing, days.length]);

  const cutoff = days[upTo] ?? "9999";
  const visible = (n: GraphNode) => !n.day || n.day <= cutoff;

  // Draw (and move) every frame.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !graph) return;
    const ctx = el.getContext("2d")!;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      if (layout === "web" && !settled.current) {
        settled.current = forceStep(graph, pos.current, vel.current, 1) < 0.05;
        // Frame the web once it has mostly spread out.
        if (!fitted.current && (settled.current || vel.current.size)) {
          const spread = [...vel.current.values()].reduce((m, v) => m + Math.abs(v.x) + Math.abs(v.y), 0) / Math.max(vel.current.size, 1);
          if (spread < 1.5) fit([...pos.current.values()]);
        }
      }
      if (layout === "tree") {
        for (const [id, t] of target.current) {
          const p = pos.current.get(id)!;
          p.x += (t.x - p.x) * 0.15;
          p.y += (t.y - p.y) * 0.15;
        }
      }
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2 + v.x, h / 2 + v.y);
      ctx.scale(v.scale, v.scale);
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      ctx.lineWidth = 1 / v.scale;
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.14)";
      ctx.beginPath();
      for (const e of graph.edges) {
        const a = byId.get(e.from)!;
        const b = byId.get(e.to)!;
        if (!visible(a) || !visible(b)) continue;
        const pa = pos.current.get(e.from)!;
        const pb = pos.current.get(e.to)!;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();
      if (layout === "tree" && days.length) {
        // The trunk.
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.25)";
        ctx.lineWidth = 3 / v.scale;
        ctx.beginPath();
        ctx.moveTo(0, 20);
        ctx.lineTo(0, pos.current.get(`day:${cutoff}`)?.y ?? 0);
        ctx.stroke();
      }
      ctx.font = `${12 / Math.max(v.scale, 0.6)}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      for (const n of graph.nodes) {
        if (!visible(n)) continue;
        const p = pos.current.get(n.id)!;
        const r = radius(n);
        ctx.fillStyle = colorOf(n);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (n.kind !== "day" || v.scale > 1.6) {
          ctx.fillStyle = dark ? "rgba(236,235,232,0.92)" : "rgba(31,29,26,0.9)";
          ctx.fillText(n.kind === "day" ? n.label.slice(5) : n.label, p.x, p.y + r + 12 / Math.max(v.scale, 0.6));
        }
      }
      frame.current = requestAnimationFrame(draw);
    };
    frame.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, layout, cutoff]);

  // Pinch, wheel and drag to move around; a tap opens the node under the finger.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: { scale: number; x: number; y: number }; dist: number; mid: Point; moved: boolean } | null>(null);
  const begin = () => {
    const [a, b] = [...pointers.current.values()];
    gesture.current = {
      view: { ...view.current },
      dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      mid: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
      moved: false,
    };
  };
  const toWorld = (p: Point): Point => {
    const r = canvas.current!.getBoundingClientRect();
    const v = view.current;
    return { x: (p.x - r.left - r.width / 2 - v.x) / v.scale, y: (p.y - r.top - r.height / 2 - v.y) / v.scale };
  };
  const zoomAround = (screen: Point, scale: number, from = view.current) => {
    const r = canvas.current!.getBoundingClientRect();
    const s = Math.min(6, Math.max(0.2, scale));
    const cx = screen.x - r.left - r.width / 2;
    const cy = screen.y - r.top - r.height / 2;
    view.current = { scale: s, x: cx - ((cx - from.x) * s) / from.scale, y: cy - ((cy - from.y) * s) / from.scale };
  };
  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAround(g.mid, (g.view.scale * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist, g.view);
      view.current.x += mid.x - g.mid.x;
      view.current.y += mid.y - g.mid.y;
      g.moved = true;
    } else {
      const dx = e.clientX - g.mid.x;
      const dy = e.clientY - g.mid.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
      view.current = { ...g.view, x: g.view.x + dx, y: g.view.y + dy };
    }
  };
  const onUp = (e: ReactPointerEvent) => {
    const g = gesture.current;
    const single = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) return begin();
    gesture.current = null;
    if (!g || g.moved || !single || !graph) return;
    const w = toWorld({ x: e.clientX, y: e.clientY });
    const hit = graph.nodes
      .filter(visible)
      .map((n) => ({ n, d: Math.hypot(pos.current.get(n.id)!.x - w.x, pos.current.get(n.id)!.y - w.y) }))
      .filter(({ n, d }) => d <= radius(n) + 10 / view.current.scale)
      .sort((a, b) => a.d - b.d)[0];
    if (hit) onOpen(hit.n);
  };

  return (
    <div className="graph-view" role="dialog" aria-label="Graph">
      <header className="graph-bar">
        <button type="button" onClick={onClose} aria-label="Close graph">✕</button>
        <div className="graph-layouts" role="tablist">
          {(["web", "tree"] as const).map((l) => (
            <button key={l} type="button" role="tab" aria-selected={layout === l} className={layout === l ? "active" : ""} onClick={() => setLayout(l)}>
              {l === "web" ? "🕸 Web" : "🌳 Tree"}
            </button>
          ))}
        </div>
        <span className="graph-legend">
          <i style={{ background: PAGE_COLOR }} /> pages <i style={{ background: TAG_COLOR }} /> tags <i className="graph-legend-days" /> days
        </span>
      </header>
      <canvas
        ref={canvas}
        className="graph-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={(e) => zoomAround({ x: e.clientX, y: e.clientY }, view.current.scale * Math.exp(-e.deltaY / 400))}
      />
      {graph && !graph.nodes.length && <p className="graph-empty">Link people and pages with [[ ]] or add #tags, and they'll appear here.</p>}
      {days.length > 1 && (
        <footer className="graph-time">
          <button type="button" onClick={() => (upTo >= days.length - 1 ? (setUpTo(0), setPlaying(true)) : setPlaying((p) => !p))} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "⏸" : "▶︎"}
          </button>
          <input
            type="range"
            min={0}
            max={days.length - 1}
            value={upTo}
            onChange={(e) => {
              setPlaying(false);
              setUpTo(Number(e.target.value));
            }}
            aria-label="Show up to day"
          />
          <span className="graph-date">{days[upTo]}</span>
        </footer>
      )}
    </div>
  );
}

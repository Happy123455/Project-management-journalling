import { useEffect, useMemo, useRef, useState } from "react";
import { loadMap, ROOT_ID, type MindMap, type MindNode } from "../lib/mindmap";
import { dayColor } from "../lib/projectDays";
import { showError, showToast } from "../lib/toast";
import type { JournalStore } from "../store";
import { growMap } from "./grow";

interface Placed {
  node: MindNode;
  x: number;
  y: number;
}

/** A radial tree from "Me": each branch gets a wedge sized by how many leaves it holds. */
function layout(map: MindMap): Map<string, Placed> {
  const kids = new Map<string, MindNode[]>();
  for (const n of map.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const leaves = (id: string): number => (kids.get(id) ?? []).reduce((s, k) => s + leaves(k.id), 0) || 1;
  const out = new Map<string, Placed>();
  const place = (n: MindNode, depth: number, from: number, to: number) => {
    const a = (from + to) / 2;
    out.set(n.id, { node: n, x: Math.cos(a) * depth * 130, y: Math.sin(a) * depth * 130 });
    let at = from;
    const total = leaves(n.id);
    for (const k of kids.get(n.id) ?? []) {
      const span = ((to - from) * leaves(k.id)) / total;
      place(k, depth + 1, at, at + span);
      at += span;
    }
  };
  const root = map.nodes.find((n) => n.id === ROOT_ID);
  if (root) place(root, 0, 0, Math.PI * 2);
  return out;
}

const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** 🧠 The evolving mind map: grows a day at a time from the journal; replay it with the slider. */
export function MindMapView({ store, today, onClose, onOpenDay }: { store: JournalStore; today: string; onClose: () => void; onOpenDay: (day: string) => void }) {
  const [map, setMap] = useState<MindMap | null>(null);
  const [upTo, setUpTo] = useState<number>(Infinity);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<MindNode | null>(null);
  const [growing, setGrowing] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, scale: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const moved = useRef(false);

  const reload = () => void loadMap(store).then((m) => (setMap(m), setUpTo(m.processedDays.length)));
  useEffect(reload, [store]);
  const placed = useMemo(() => (map ? layout(map) : new Map<string, Placed>()), [map]);
  const days = map?.processedDays ?? [];
  const lastDay = days[Math.min(upTo, days.length) - 1] ?? "";
  const visible = (n: MindNode) => n.id === ROOT_ID || (!!lastDay && n.firstSeenDay <= lastDay);

  const draw = () => {
    const c = canvas.current;
    if (!c || !map) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const ctx = c.getContext("2d")!;
    const { x, y, scale } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2 + x, h / 2 + y);
    ctx.scale(scale, scale);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    // Cross-links, faint and dashed.
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    for (const l of map.links) {
      const a = placed.get(l.from);
      const b = placed.get(l.to);
      if (!a || !b || !visible(a.node) || !visible(b.node) || l.firstSeenDay > lastDay) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Branches: thicker for ideas that keep coming back.
    for (const p of placed.values()) {
      const parent = p.node.parent ? placed.get(p.node.parent) : null;
      if (!parent || !visible(p.node)) continue;
      ctx.strokeStyle = p.node.firstSeenDay ? dayColor(p.node.firstSeenDay) : "#888";
      ctx.lineWidth = 1.5 + Math.log2(p.node.weight + 1) * 1.6;
      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      ctx.quadraticCurveTo((parent.x + p.x) / 2, (parent.y + p.y) / 2 - 10, p.x, p.y);
      ctx.stroke();
    }
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const p of placed.values()) {
      if (!visible(p.node)) continue;
      const r = p.node.id === ROOT_ID ? 16 : 6 + Math.min(10, p.node.weight);
      ctx.fillStyle = p.node.id === ROOT_ID ? "#a78bfa" : dayColor(p.node.firstSeenDay || "2026-01-15");
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (picked?.id === p.node.id) {
        ctx.strokeStyle = dark ? "#fff" : "#000";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = dark ? "#eee" : "#222";
      ctx.fillText(p.node.label, p.x, p.y - r - 6);
    }
  };
  useEffect(draw);
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  // ▶ replays the growth a day at a time.
  useEffect(() => {
    if (!playing) return;
    if (upTo >= days.length) return setPlaying(false);
    const t = window.setTimeout(() => setUpTo((u) => u + 1), 450);
    return () => window.clearTimeout(t);
  }, [playing, upTo, days.length]);

  const toWorld = (cx: number, cy: number) => {
    const c = canvas.current!.getBoundingClientRect();
    const { x, y, scale } = view.current;
    return { x: (cx - c.left - c.width / 2 - x) / scale, y: (cy - c.top - c.height / 2 - y) / scale };
  };
  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinch.current) view.current.scale = Math.max(0.2, Math.min(4, view.current.scale * (d / pinch.current)));
      pinch.current = d;
    } else {
      view.current.x += e.clientX - prev.x;
      view.current.y += e.clientY - prev.y;
    }
    if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 2) moved.current = true;
    draw();
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (moved.current) return;
    const at = toWorld(e.clientX, e.clientY);
    let best: Placed | null = null;
    let dist = 28 / view.current.scale;
    for (const p of placed.values()) {
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (visible(p.node) && d < dist) [best, dist] = [p, d];
    }
    setPicked(best?.node ?? null);
  };

  const grow = async () => {
    setGrowing(true);
    try {
      const added = await growMap(store, today);
      showToast(added === null ? "Today is already in the map (or the note is empty)" : `Mind map grew by ${added} idea${added === 1 ? "" : "s"}`);
      reload();
    } catch (e) {
      showError("Couldn't grow the mind map", e);
    } finally {
      setGrowing(false);
    }
  };

  return (
    <div className="settings-view mindmap-view" role="dialog" aria-label="Mind map">
      <header className="graph-bar">
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
        <h1 className="settings-title">🧠 Mind map</h1>
        <button type="button" onClick={() => void grow()} disabled={growing}>{growing ? "Growing…" : "🌱 Grow map"}</button>
      </header>
      <canvas
        ref={canvas}
        className="mindmap-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={(e) => {
          view.current.scale = Math.max(0.2, Math.min(4, view.current.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
          draw();
        }}
      />
      {map && map.nodes.length <= 1 && (
        <p className="hint mindmap-empty">Your map starts with “Me”. Tap 🌱 Grow map to add today's ideas, and it grows a little with every day you write.</p>
      )}
      {picked && picked.id !== ROOT_ID && (
        <div className="mindmap-picked">
          <strong>{picked.label}</strong> <span className="hint">{picked.kind} · seen {picked.weight}×</span>
          <div className="mindmap-days">
            {picked.days.map((d) => (
              <button key={d} type="button" onClick={() => onOpenDay(d)}>{short(d)}</button>
            ))}
          </div>
        </div>
      )}
      {days.length > 0 && (
        <div className="mindmap-time">
          <button type="button" onClick={() => (upTo >= days.length && setUpTo(0), setPlaying(!playing))} aria-label={playing ? "Pause" : "Replay growth"}>{playing ? "⏸" : "▶"}</button>
          <input type="range" min={0} max={days.length} value={Math.min(upTo, days.length)} onChange={(e) => (setPlaying(false), setUpTo(Number(e.target.value)))} aria-label="Day" />
          <span className="hint">{lastDay ? short(lastDay) : "start"}</span>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { loadMap, MAP_PAGE, placeNew, projectMapPage, ROOT_ID, saveMap, type MindMap, type MindNode } from "../lib/mindmap";
import { dayColor } from "../lib/projectDays";
import { arrange, edgeStyle, loadMindLayout, MIND_LAYOUTS, saveMindLayout, type MindLayout } from "../lib/mindLayout";
import { showError, showToast } from "../lib/toast";
import type { JournalStore, NamedPage } from "../store";
import { growMap, growPending, growProjectMap, MAP_SKILL, pendingDays, PROJECT_SKILL, tidyMap } from "./grow";

interface Placed {
  node: MindNode;
  x: number;
  y: number;
}

/**
 * "As it grew": every node where it was first placed (placeNew never moves one), so the map grows
 * like a tree. The other layouts arrange the same tree neatly (radial, trees, charts).
 */
function layout(map: MindMap, mode: MindLayout): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const nodes = placeNew(map).nodes;
  const at = mode === "grown" ? null : arrange(map, mode);
  for (const n of nodes) {
    const p = at?.get(n.id);
    out.set(n.id, { node: n, x: p ? p.x : n.x ?? 0, y: p ? p.y : n.y ?? 0 });
  }
  return out;
}

/** The view that shows all of `placed` in a canvas of this size. */
function fitView(placed: Map<string, Placed>, c: HTMLCanvasElement | null) {
  const ps = [...placed.values()];
  if (!ps.length) return { x: 0, y: 0, scale: 1 };
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = c ? Math.max(0.25, Math.min(1.2, (c.clientWidth - 80) / Math.max(1, maxX - minX), (c.clientHeight - 80) / Math.max(1, maxY - minY))) : 1;
  return { x: (-(minX + maxX) / 2) * scale, y: (-(minY + maxY) / 2) * scale, scale };
}

const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** 🧠 The evolving mind map: grows a day at a time from the journal; replay it with the slider. */
export function MindMapView({ store, today, onClose, onOpenDay, onOpenPage }: { store: JournalStore; today: string; onClose: () => void; onOpenDay: (day: string) => void; onOpenPage: (title: string) => void }) {
  const [map, setMap] = useState<MindMap | null>(null);
  // Whose map: yours ("Me", from every note) or one project's (from its own text only).
  const [projects, setProjects] = useState<NamedPage[]>([]);
  const [which, setWhich] = useState<string>("");
  const project = projects.find((p) => p.title === which) ?? null;
  const [pending, setPending] = useState(0);
  const [progress, setProgress] = useState("");
  const [upTo, setUpTo] = useState<number>(Infinity);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<MindNode | null>(null);
  const [growing, setGrowing] = useState(false);
  const [mode, setMode] = useState<MindLayout>(loadMindLayout);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, scale: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const moved = useRef(false);

  const pageTitle = project ? projectMapPage(project.title) : MAP_PAGE;
  const reload = () =>
    void loadMap(store, pageTitle, project?.title ?? "Me").then(async (m) => {
      // Maps from before places were kept: placed once now, then never moved.
      if (m.nodes.some((n) => n.x == null)) {
        m = placeNew(m);
        if (m.nodes.length > 1) await saveMap(store, m, "me", pageTitle).catch(() => {});
      }
      setMap(m);
      setUpTo(m.processedDays.length);
      // The whole map in view to start with.
      view.current = fitView(layout(m, modeRef.current), canvas.current);
    });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(reload, [store, pageTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void store.projects().then((p) => setProjects(p.filter((x) => x.props.project?.status !== "done")), () => {});
    void pendingDays(store, today).then((d) => setPending(d.length), () => {});
  }, [store, today]);
  const placed = useMemo(() => (map ? layout(map, mode) : new Map<string, Placed>()), [map, mode]);
  const pickLayout = (next: MindLayout) => {
    setMode(next);
    saveMindLayout(next);
    if (map) view.current = fitView(layout(map, next), canvas.current);
  };
  const edges = edgeStyle(mode);
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
    // Light or dark as the page actually is (the theme can differ from the system).
    const ink = getComputedStyle(c).color || "#222";
    const dark = (() => {
      const m = ink.match(/\d+/g);
      return !!m && Number(m[0]) + Number(m[1]) + Number(m[2]) > 382;
    })();
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
      if (edges === "elbow-x") {
        // Logic chart: across from the parent, then a bracket down/up to the child.
        const mx = (parent.x + p.x) / 2;
        ctx.lineTo(mx, parent.y);
        ctx.lineTo(mx, p.y);
        ctx.lineTo(p.x, p.y);
      } else if (edges === "elbow-y") {
        // Organization chart: down from the parent, across, down to the child.
        const my = (parent.y + p.y) / 2;
        ctx.lineTo(parent.x, my);
        ctx.lineTo(p.x, my);
        ctx.lineTo(p.x, p.y);
      } else if (mode === "right" || mode === "left") ctx.bezierCurveTo((parent.x + p.x) / 2, parent.y, (parent.x + p.x) / 2, p.y, p.x, p.y);
      else ctx.quadraticCurveTo((parent.x + p.x) / 2, (parent.y + p.y) / 2 - 10, p.x, p.y);
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
      // A halo in the page's colour, so the branch lines never run through the words.
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = dark ? "rgba(20,22,30,0.9)" : "rgba(255,255,255,0.9)";
      ctx.strokeText(p.node.label, p.x, p.y - r - 6);
      ctx.fillStyle = ink;
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

  const run = async (what: string, job: () => Promise<string>) => {
    setGrowing(true);
    setProgress(what);
    try {
      showToast(await job());
      reload();
    } catch (e) {
      showError("Couldn't grow the mind map", e);
    } finally {
      setGrowing(false);
      setProgress("");
    }
  };
  const ideas = (n: number | null) => `${n} idea${n === 1 ? "" : "s"}`;
  const grow = () =>
    run("Growing…", async () => {
      if (project) {
        // A first build can take a few rounds (each adds up to 12).
        let total = 0;
        for (let round = 0; round < 3; round++) {
          const added = await growProjectMap(store, project, round > 0 || total > 0);
          if (added == null) break;
          total += added;
          if (added < 12) break;
        }
        return total ? `${project.title}'s map grew by ${ideas(total)}` : "Nothing new in the project's text";
      }
      const added = await growMap(store, today, 1, true);
      return added === null ? "Today's note is empty" : `Mind map grew by ${ideas(added)}`;
    });
  const readAll = () =>
    run("Reading notes…", async () => {
      const added = await growPending(store, today, 40, (done, total) => setProgress(`Reading notes ${done}/${total}…`));
      setPending((await pendingDays(store, today)).length);
      return `Read the notes: ${ideas(added)} added`;
    });
  const tidy = () =>
    run("Tidying…", async () => {
      const folded = await tidyMap(store, pageTitle, project ? PROJECT_SKILL : MAP_SKILL);
      return folded ? `Folded ${folded} duplicate${folded === 1 ? "" : "s"} together` : "Already tidy";
    });

  return (
    <div className="settings-view mindmap-view" role="dialog" aria-label="Mind map">
      <header className="graph-bar">
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
        <h1 className="settings-title">🧠 Mind map</h1>
        <button type="button" onClick={() => void grow()} disabled={growing}>{growing ? progress || "Growing…" : "🌱 Grow"}</button>
      </header>
      <div className="mindmap-tools">
        <select value={which} onChange={(e) => (setPicked(null), setWhich(e.target.value))} aria-label="Whose map">
          <option value="">🧠 Me (every note)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.title}>📌 {p.title}</option>
          ))}
        </select>
        {!project && pending > 0 && (
          <button type="button" onClick={() => void readAll()} disabled={growing} title="Read every note not in the map yet, oldest first">
            📚 Read {pending} note{pending === 1 ? "" : "s"}
          </button>
        )}
        <select value={mode} onChange={(e) => pickLayout(e.target.value as MindLayout)} aria-label="Layout" title="How the map is arranged">
          {MIND_LAYOUTS.map((l) => (
            <option key={l.value} value={l.value}>{l.icon} {l.label}</option>
          ))}
        </select>
        <button type="button" onClick={() => void tidy()} disabled={growing} title="Fold duplicates together; the skill learns from the map">🧹 Tidy</button>
        <button type="button" onClick={() => onOpenPage(project ? PROJECT_SKILL : MAP_SKILL)} title="The method the AI follows (you can change it)">📜 Skill</button>
      </div>
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
        <p className="hint mindmap-empty">
          {project
            ? `Tap 🌱 Grow to build ${project.title}'s map from its own text only (its page and its boxes in your notes).`
            : "Your map starts with “Me”. Tap 🌱 Grow for today's ideas, or 📚 Read to go through every note. It grows by itself as you write."}
        </p>
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

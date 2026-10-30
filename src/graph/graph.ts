import type { GraphLink } from "../store/types";

export type NodeKind = "day" | "page" | "tag";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Day nodes: the day. Pages and tags: the first day that mentions them (for the time-lapse). */
  day: string | null;
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const pageId = (title: string) => `page:${title.trim().toLowerCase()}`;
const tagId = (tag: string) => `tag:${tag.toLowerCase()}`;

/** Days, pages and tags as nodes, with an edge for every link or tag. */
export function buildGraph(links: GraphLink[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const node = (id: string, kind: NodeKind, label: string, day: string | null) => {
    const n = nodes.get(id) ?? { id, kind, label, day, degree: 0 };
    if (day && (!n.day || day < n.day)) n.day = day;
    nodes.set(id, n);
    return n;
  };
  for (const l of links) {
    const from = l.day ? node(`day:${l.day}`, "day", l.day, l.day) : node(pageId(l.title ?? ""), "page", l.title ?? "", null);
    const to = l.kind === "tag" ? node(tagId(l.target), "tag", `#${l.target}`, l.day) : node(pageId(l.target), "page", l.target, l.day);
    const key = `${from.id}→${to.id}`;
    if (from.id === to.id || edges.has(key)) continue;
    edges.set(key, { from: from.id, to: to.id });
    from.degree++;
    to.degree++;
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * A day's colour: one hue per month (January blue, then +30° each month around the wheel),
 * light on the 1st and darker towards the 31st.
 */
export function dayColor(day: string): string {
  const month = Number(day.slice(5, 7)) - 1;
  const date = Number(day.slice(8, 10));
  const hue = (220 + month * 30) % 360;
  const lightness = Math.round(78 - ((date - 1) / 30) * 42);
  return `hsl(${hue}, 75%, ${lightness}%)`;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Tree layout, growing upwards over time: days sit on a vertical trunk in date order (oldest at
 * the bottom), and each page or tag branches out to the left or right at the height of the day
 * that first mentions it.
 */
export function treeLayout(graph: Graph, gap = 56): Map<string, Point> {
  const pos = new Map<string, Point>();
  const days = graph.nodes.filter((n) => n.kind === "day").sort((a, b) => a.label.localeCompare(b.label));
  // Days zig-zag a little either side of the trunk so neighbours don't touch.
  days.forEach((d, i) => pos.set(d.id, { x: i % 2 ? 16 : -16, y: -i * gap }));
  const dayIndex = new Map(days.map((d, i) => [d.day, i]));
  const hubs = graph.nodes.filter((n) => n.kind !== "day").sort((a, b) => (a.day ?? "~").localeCompare(b.day ?? "~") || a.label.localeCompare(b.label));
  // Each side has columns (lanes) outward from the trunk; a branch takes the nearest lane that is
  // free around its height, so labels never sit on top of each other.
  const lanes: Record<1 | -1, number[][]> = { 1: [], [-1]: [] };
  hubs.forEach((h, i) => {
    const level = h.day ? (dayIndex.get(h.day) ?? days.length) : days.length;
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
    const sideLanes = lanes[side];
    let lane = sideLanes.findIndex((ys) => ys.every((y) => Math.abs(y - level) >= 1.6));
    if (lane < 0) lane = sideLanes.push([]) - 1;
    sideLanes[lane].push(level);
    pos.set(h.id, { x: side * (130 + lane * 150), y: -level * gap - 14 });
  });
  return pos;
}

/** One step of a simple force layout (Web view): nodes repel, edges pull, everything drifts to the centre. */
export function forceStep(graph: Graph, pos: Map<string, Point>, vel: Map<string, Point>, strength = 1): number {
  const ids = graph.nodes.map((n) => n.id);
  const force = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
  for (let i = 0; i < ids.length; i++) {
    const a = pos.get(ids[i])!;
    for (let j = i + 1; j < ids.length; j++) {
      const b = pos.get(ids[j])!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = Math.max(dx * dx + dy * dy, 25);
      const f = 5200 / d2;
      const d = Math.sqrt(d2);
      force.get(ids[i])!.x += (dx / d) * f;
      force.get(ids[i])!.y += (dy / d) * f;
      force.get(ids[j])!.x -= (dx / d) * f;
      force.get(ids[j])!.y -= (dy / d) * f;
    }
  }
  // Edges act like springs that like to be about 70px long.
  for (const e of graph.edges) {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.hypot(dx, dy), 1);
    const f = (d - 70) * 0.03;
    force.get(e.from)!.x += (dx / d) * f;
    force.get(e.from)!.y += (dy / d) * f;
    force.get(e.to)!.x -= (dx / d) * f;
    force.get(e.to)!.y -= (dy / d) * f;
  }
  let moved = 0;
  for (const id of ids) {
    const p = pos.get(id)!;
    const v = vel.get(id) ?? { x: 0, y: 0 };
    const f = force.get(id)!;
    v.x = (v.x + (f.x - p.x * 0.01) * strength) * 0.82;
    v.y = (v.y + (f.y - p.y * 0.01) * strength) * 0.82;
    p.x += v.x;
    p.y += v.y;
    vel.set(id, v);
    moved += Math.abs(v.x) + Math.abs(v.y);
  }
  return moved / Math.max(ids.length, 1);
}

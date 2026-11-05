import type { JSONContent } from "@tiptap/react";
import type { JournalStore, NamedPage } from "../store";

/** The evolving mind map: grown a day at a time from the journal, never rebuilt. */
export type MindKind = "theme" | "idea" | "person" | "project" | "feeling" | "goal" | "task" | "question" | "decision" | "resource";
export interface MindNode {
  id: string;
  label: string;
  kind: MindKind;
  parent: string | null;
  firstSeenDay: string;
  lastSeenDay: string;
  weight: number;
  /** Days that added or reinforced it. */
  days: string[];
  /** Where it sits on the map. Set once when it first appears and never moved, so the map grows like a tree. */
  x?: number;
  y?: number;
}
export interface MindMap {
  nodes: MindNode[];
  /** Cross-links between branches (the tree edges are each node's parent). */
  links: { from: string; to: string; firstSeenDay: string }[];
  processedDays: string[];
  /** Words a day (or a project's text, under "project") had when it was last grown from: grown again once it's grown a lot. */
  processedWords?: Record<string, number>;
}
export interface Growth {
  /** `id`: a short new id for this node, so later attaches in the same answer can hang under it. */
  attach: { existingId: string; newLabel: string; kind: MindKind; id?: string }[];
  reinforce: string[];
  link: { a: string; b: string }[];
  /** Tidying: `from` is the same idea as `into` (its days and branches move there, it goes). */
  merge?: { from: string; into: string }[];
}

export const ROOT_ID = "me";
export const MAX_NEW_PER_DAY = 12;
const KINDS: MindKind[] = ["theme", "idea", "person", "project", "feeling", "goal", "task", "question", "decision", "resource"];

export const emptyMap = (): MindMap => ({
  nodes: [{ id: ROOT_ID, label: "Me", kind: "theme", parent: null, firstSeenDay: "", lastSeenDay: "", weight: 1, days: [] }],
  links: [],
  processedDays: [],
});

/** The AI's answer, checked: anything malformed is dropped, never trusted. */
export function parseGrowth(raw: unknown): Growth {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    attach: arr(o.attach).flatMap((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      const label = str(x.newLabel).slice(0, 60);
      const kind = KINDS.includes(x.kind as MindKind) ? (x.kind as MindKind) : "idea";
      const id = str(x.id);
      return str(x.existingId) && label ? [{ existingId: str(x.existingId), newLabel: label, kind, ...(id ? { id } : {}) }] : [];
    }),
    reinforce: arr(o.reinforce).map(str).filter(Boolean),
    link: arr(o.link).flatMap((l) => {
      const x = (l ?? {}) as Record<string, unknown>;
      return str(x.a) && str(x.b) && str(x.a) !== str(x.b) ? [{ a: str(x.a), b: str(x.b) }] : [];
    }),
    ...(Array.isArray(o.merge)
      ? {
          merge: arr(o.merge).flatMap((m) => {
            const x = (m ?? {}) as Record<string, unknown>;
            return str(x.from) && str(x.into) && str(x.from) !== str(x.into) ? [{ from: str(x.from), into: str(x.into) }] : [];
          }),
        }
      : {}),
  };
}

/** Adds one day's growth: new branches on existing nodes, reinforcement, cross-links. Nothing is removed. */
export function applyGrowth(map: MindMap, growth: Growth, day: string, newId: () => string, again = false): MindMap {
  if (map.processedDays.includes(day) && !again) return map;
  const nodes = map.nodes.map((n) => ({ ...n, days: [...n.days] }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const touch = (n: MindNode) => {
    // Once per day: growing the same day again never counts it twice.
    if (n.days.includes(day)) return;
    n.weight += 1;
    if (!n.firstSeenDay) n.firstSeenDay = day;
    if (day > n.lastSeenDay) n.lastSeenDay = day;
    if (!n.days.includes(day)) n.days.push(day);
  };
  for (const id of new Set(growth.reinforce)) {
    const n = byId.get(id);
    if (n && n.id !== ROOT_ID) touch(n);
  }
  let added = 0;
  // New nodes named in this answer ("n1"…), so a whole branch can arrive at once.
  const temp = new Map<string, string>();
  for (const a of growth.attach) {
    if (added >= MAX_NEW_PER_DAY) break;
    const parent = byId.get(temp.get(a.existingId) ?? a.existingId);
    if (!parent) continue;
    const twin = nodes.find((n) => n.parent === parent.id && n.label.toLowerCase() === a.newLabel.toLowerCase());
    if (twin) {
      touch(twin);
      if (a.id) temp.set(a.id, twin.id);
      continue;
    }
    const node: MindNode = { id: newId(), label: a.newLabel, kind: a.kind, parent: parent.id, firstSeenDay: day, lastSeenDay: day, weight: 1, days: [day] };
    nodes.push(node);
    byId.set(node.id, node);
    if (a.id && !byId.has(a.id)) temp.set(a.id, node.id);
    added++;
  }
  const links = [...map.links];
  for (const raw of growth.link) {
    const l = { a: temp.get(raw.a) ?? raw.a, b: temp.get(raw.b) ?? raw.b };
    if (!byId.has(l.a) || !byId.has(l.b) || links.some((x) => (x.from === l.a && x.to === l.b) || (x.from === l.b && x.to === l.a))) continue;
    links.push({ from: l.a, to: l.b, firstSeenDay: day });
  }
  return { ...map, nodes, links, processedDays: [...new Set([...map.processedDays, day])].sort() };
}

/** Tidying: each `from` folds into `into` (days, weight and branches move; branches keep their place). */
export function applyMerges(map: MindMap, merges: { from: string; into: string }[]): MindMap {
  let nodes = map.nodes.map((n) => ({ ...n, days: [...n.days] }));
  let links = [...map.links];
  for (const { from, into } of merges) {
    const a = nodes.find((n) => n.id === from);
    const b = nodes.find((n) => n.id === into);
    if (!a || !b || a.id === ROOT_ID) continue;
    // Never into its own branch (that would cut the tree loose).
    let up: MindNode | undefined = b;
    while (up && up.id !== a.id) up = nodes.find((n) => n.id === up!.parent);
    if (up) continue;
    b.days = [...new Set([...b.days, ...a.days])].sort();
    b.weight += a.weight;
    if (a.firstSeenDay && (!b.firstSeenDay || a.firstSeenDay < b.firstSeenDay)) b.firstSeenDay = a.firstSeenDay;
    if (a.lastSeenDay > b.lastSeenDay) b.lastSeenDay = a.lastSeenDay;
    nodes = nodes.filter((n) => n.id !== a.id).map((n) => (n.parent === a.id ? { ...n, parent: b.id } : n));
    links = links.map((l) => ({ ...l, from: l.from === a.id ? b.id : l.from, to: l.to === a.id ? b.id : l.to })).filter((l) => l.from !== l.to);
  }
  return { ...map, nodes, links };
}

/** Room each label needs on the map. */
const SPACING = 70;

/**
 * Gives every node that has no place yet a place, without moving any that have one: a child goes out
 * from its parent in the direction its branch is growing (the root's children into the widest free
 * gap), fanning out to the sides and further out when the spot is taken. So the map grows like a tree.
 */
export function placeNew(map: MindMap): MindMap {
  const nodes = map.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(ROOT_ID);
  if (!root) return map;
  if (root.x == null || root.y == null) [root.x, root.y] = [0, 0];
  const depthOf = (n: MindNode): number => {
    let d = 0;
    let at: MindNode | undefined = n;
    while (at && at.parent && d < 50) {
      at = byId.get(at.parent);
      d++;
    }
    return d;
  };
  const placed = nodes.filter((n) => n.x != null && n.y != null);
  const todo = nodes.filter((n) => n.x == null || n.y == null).sort((a, b) => depthOf(a) - depthOf(b) || a.firstSeenDay.localeCompare(b.firstSeenDay));
  if (!todo.length) return map;
  const deg = Math.PI / 180;
  for (const n of todo) {
    const p = (n.parent && byId.get(n.parent)) || root;
    if (p.x == null || p.y == null) [p.x, p.y] = [0, 0];
    const depth = depthOf(n);
    let base: number;
    let offsets: number[];
    if (p.id === ROOT_ID) {
      // The middle of the widest gap between the root's branches.
      const angles = placed.filter((x) => x.parent === ROOT_ID).map((x) => Math.atan2(x.y! - p.y!, x.x! - p.x!)).sort((a, b) => a - b);
      if (!angles.length) base = -Math.PI / 2;
      else {
        let gap = -1;
        base = angles[0] + Math.PI;
        angles.forEach((a, i) => {
          const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
          if (next - a > gap) [gap, base] = [next - a, (a + next) / 2];
        });
      }
      offsets = [0, 12, -12, 24, -24];
    } else {
      const gp = (p.parent && byId.get(p.parent)) || root;
      base = Math.atan2(p.y - (gp.y ?? 0), p.x - (gp.x ?? 0));
      offsets = [0, 24, -24, 46, -46, 68, -68, 90, -90, 115, -115];
    }
    const r0 = p.id === ROOT_ID ? 150 : Math.max(95, 135 - depth * 10);
    let best = { x: p.x + Math.cos(base) * r0, y: p.y + Math.sin(base) * r0, room: -1 };
    search: for (const k of [1, 1.35, 1.75, 2.2, 2.8]) {
      for (const off of offsets) {
        const a = base + off * deg;
        const x = p.x + Math.cos(a) * r0 * k;
        const y = p.y + Math.sin(a) * r0 * k;
        const room = placed.reduce((m, q) => Math.min(m, Math.hypot(q.x! - x, q.y! - y)), Infinity);
        if (room >= SPACING) {
          best = { x, y, room };
          break search;
        }
        if (room > best.room) best = { x, y, room };
      }
    }
    n.x = Math.round(best.x);
    n.y = Math.round(best.y);
    placed.push(n);
  }
  return { ...map, nodes };
}

/** What the AI sees of the map: the strongest nodes with their ids. */
export function mapSummary(map: MindMap, limit = 150): string {
  return [...map.nodes]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((n) => `${n.id}\t${n.label}\t${n.kind}\tw${n.weight}`)
    .join("\n");
}

// ───────────── Kept as a page, so it syncs and every AI change can be undone ─────────────

export const MAP_PAGE = "Mind map data";

export function mapToContent(map: MindMap): JSONContent {
  return { type: "doc", content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: JSON.stringify(map) }] }] };
}

export function mapFromPage(page: NamedPage | null): MindMap {
  try {
    const text = page?.content?.content?.[0]?.content?.[0]?.text;
    const map = text ? (JSON.parse(text) as MindMap) : null;
    return map?.nodes?.length ? map : emptyMap();
  } catch {
    return emptyMap();
  }
}

/** A project's own map is kept on its own page. */
export const projectMapPage = (title: string) => `Project map data · ${title}`;

export async function loadMap(store: JournalStore, pageTitle = MAP_PAGE, rootLabel = "Me"): Promise<MindMap> {
  const map = mapFromPage(await store.getPage(pageTitle));
  const root = map.nodes.find((n) => n.id === ROOT_ID);
  if (root && root.label !== rootLabel && pageTitle !== MAP_PAGE) root.label = rootLabel;
  return map;
}

export async function saveMap(store: JournalStore, map: MindMap, actor: string, pageTitle = MAP_PAGE) {
  const page = await store.ensurePage(pageTitle);
  const content = mapToContent(map);
  await store.savePage({ id: page.id, content, plainText: `Mind map: ${map.nodes.length} ideas`, actor });
}

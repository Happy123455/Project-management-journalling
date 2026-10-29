import type { JSONContent } from "@tiptap/react";
import type { JournalStore, NamedPage } from "../store";

/** The evolving mind map: grown a day at a time from the journal, never rebuilt. */
export type MindKind = "theme" | "idea" | "person" | "project" | "feeling";
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
}
export interface MindMap {
  nodes: MindNode[];
  /** Cross-links between branches (the tree edges are each node's parent). */
  links: { from: string; to: string; firstSeenDay: string }[];
  processedDays: string[];
}
export interface Growth {
  attach: { existingId: string; newLabel: string; kind: MindKind }[];
  reinforce: string[];
  link: { a: string; b: string }[];
}

export const ROOT_ID = "me";
export const MAX_NEW_PER_DAY = 12;
const KINDS: MindKind[] = ["theme", "idea", "person", "project", "feeling"];

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
      return str(x.existingId) && label ? [{ existingId: str(x.existingId), newLabel: label, kind }] : [];
    }),
    reinforce: arr(o.reinforce).map(str).filter(Boolean),
    link: arr(o.link).flatMap((l) => {
      const x = (l ?? {}) as Record<string, unknown>;
      return str(x.a) && str(x.b) && str(x.a) !== str(x.b) ? [{ a: str(x.a), b: str(x.b) }] : [];
    }),
  };
}

/** Adds one day's growth: new branches on existing nodes, reinforcement, cross-links. Nothing is removed. */
export function applyGrowth(map: MindMap, growth: Growth, day: string, newId: () => string): MindMap {
  if (map.processedDays.includes(day)) return map;
  const nodes = map.nodes.map((n) => ({ ...n, days: [...n.days] }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const touch = (n: MindNode) => {
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
  for (const a of growth.attach) {
    if (added >= MAX_NEW_PER_DAY) break;
    const parent = byId.get(a.existingId);
    if (!parent) continue;
    const twin = nodes.find((n) => n.parent === parent.id && n.label.toLowerCase() === a.newLabel.toLowerCase());
    if (twin) {
      touch(twin);
      continue;
    }
    const node: MindNode = { id: newId(), label: a.newLabel, kind: a.kind, parent: parent.id, firstSeenDay: day, lastSeenDay: day, weight: 1, days: [day] };
    nodes.push(node);
    byId.set(node.id, node);
    added++;
  }
  const links = [...map.links];
  for (const l of growth.link) {
    if (!byId.has(l.a) || !byId.has(l.b) || links.some((x) => (x.from === l.a && x.to === l.b) || (x.from === l.b && x.to === l.a))) continue;
    links.push({ from: l.a, to: l.b, firstSeenDay: day });
  }
  return { nodes, links, processedDays: [...map.processedDays, day].sort() };
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

export async function loadMap(store: JournalStore): Promise<MindMap> {
  return mapFromPage(await store.getPage(MAP_PAGE));
}

export async function saveMap(store: JournalStore, map: MindMap, actor: string) {
  const page = await store.ensurePage(MAP_PAGE);
  const content = mapToContent(map);
  await store.savePage({ id: page.id, content, plainText: `Mind map: ${map.nodes.length} ideas`, actor });
}

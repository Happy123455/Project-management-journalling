import { ROOT_ID, type MindMap } from "./mindmap";

/**
 * How the mind map is laid out. "grown" keeps every idea where it first appeared (the map grows like
 * a tree, see placeNew); the others arrange the same tree neatly each time it's drawn.
 */
export type MindLayout = "grown" | "radial" | "right" | "left" | "org" | "logic";
export const MIND_LAYOUTS: { value: MindLayout; label: string; icon: string }[] = [
  { value: "grown", label: "As it grew", icon: "🌱" },
  { value: "radial", label: "Radial map", icon: "✺" },
  { value: "right", label: "Right-aligned tree", icon: "⊢" },
  { value: "left", label: "Left-aligned tree", icon: "⊣" },
  { value: "org", label: "Organization chart", icon: "⊤" },
  { value: "logic", label: "Logic chart", icon: "⊏" },
];
const KEY = "journal.mindLayout";
export function loadMindLayout(): MindLayout {
  try {
    const v = localStorage.getItem(KEY) as MindLayout | null;
    return MIND_LAYOUTS.some((l) => l.value === v) ? v! : "grown";
  } catch {
    return "grown";
  }
}
export function saveMindLayout(l: MindLayout) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // Not kept on this device.
  }
}

/** Branch lines: curves for the maps, right-angled brackets for the charts. */
export const edgeStyle = (l: MindLayout): "curve" | "elbow-x" | "elbow-y" => (l === "logic" ? "elbow-x" : l === "org" ? "elbow-y" : "curve");

/** Positions for every node of `map` in layout `l` (not for "grown": that uses the saved x/y). */
export function arrange(map: MindMap, l: Exclude<MindLayout, "grown">): Map<string, { x: number; y: number }> {
  const kids = new Map<string, string[]>();
  const ids = new Set(map.nodes.map((n) => n.id));
  for (const n of map.nodes) {
    // A node whose parent is gone hangs off the root, so nothing floats loose.
    const p = n.id === ROOT_ID ? null : n.parent && ids.has(n.parent) ? n.parent : ROOT_ID;
    if (p == null) continue;
    kids.set(p, [...(kids.get(p) ?? []), n.id]);
  }
  // Heavier branches first, then oldest: a steady order between draws.
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  for (const list of kids.values())
    list.sort((a, b) => (byId.get(b)!.weight - byId.get(a)!.weight) || (byId.get(a)!.firstSeenDay || "").localeCompare(byId.get(b)!.firstSeenDay || ""));
  const leaves = new Map<string, number>();
  const seen = new Set<string>();
  const count = (id: string): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const c = (kids.get(id) ?? []).reduce((s, k) => s + count(k), 0);
    const n = Math.max(1, c);
    leaves.set(id, n);
    return n;
  };
  count(ROOT_ID);
  const out = new Map<string, { x: number; y: number }>();
  const placedOnce = new Set<string>();

  if (l === "radial") {
    const RING = 150;
    const walk = (id: string, depth: number, a0: number, a1: number) => {
      if (placedOnce.has(id)) return;
      placedOnce.add(id);
      const mid = (a0 + a1) / 2;
      out.set(id, depth ? { x: Math.cos(mid) * depth * RING, y: Math.sin(mid) * depth * RING } : { x: 0, y: 0 });
      let a = a0;
      const total = leaves.get(id) ?? 1;
      for (const k of kids.get(id) ?? []) {
        const span = ((a1 - a0) * (leaves.get(k) ?? 1)) / total;
        walk(k, depth + 1, a, a + span);
        a += span;
      }
    };
    walk(ROOT_ID, 0, -Math.PI / 2, Math.PI * 1.5);
    return out;
  }

  // Trees and charts: one row (or column) per leaf, each parent centred on its children.
  const across = l === "org" ? 150 : 54; // between neighbouring leaves
  const along = l === "org" ? 96 : l === "logic" ? 190 : 210; // between generations
  const dir = l === "left" ? -1 : 1;
  let slot = 0;
  const walk = (id: string, depth: number): number => {
    if (placedOnce.has(id)) return 0;
    placedOnce.add(id);
    const list = (kids.get(id) ?? []).filter((k) => !placedOnce.has(k));
    let pos: number;
    if (!list.length) pos = slot++ * across;
    else {
      const ps = list.map((k) => walk(k, depth + 1));
      pos = (ps[0] + ps[ps.length - 1]) / 2;
    }
    out.set(id, l === "org" ? { x: pos, y: depth * along } : { x: dir * depth * along, y: pos });
    return pos;
  };
  walk(ROOT_ID, 0);
  return out;
}

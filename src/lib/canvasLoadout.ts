import type { CanvasItem } from "./canvas";
import { shortLabel } from "./canvas";
import { dayKey } from "./timestamp";

/**
 * Graph loadouts: ready-made graphs to look at in Canvas next to the note's own map. Each one is a
 * page called "Graph · <name>" holding its data as JSON (so it syncs to the phone). The first kind
 * is the prompt map: prompts split into parts, each part on a feature branch (the format of the
 * "Journaling Prompt Map" page: { features, prompts, segs }).
 */
export const GRAPH_PREFIX = "Graph · ";

export interface PromptMapData {
  title?: string;
  features: { id: string; label: string }[];
  prompts: { t: string; text: string; thread?: string }[];
  segs: { p: number; f: string; k?: number; text: string }[];
}

/** Extra facts about a loadout node: the prompt it came from. */
export interface LoadoutInfo {
  prompt: number;
  promptCount: number;
  thread: string;
  full: string;
  /** Where this part sits in the full prompt. */
  start: number;
  end: number;
  /** The other parts of the same prompt (item keys), in order. */
  parts: string[];
}

export interface Loadout {
  title: string;
  items: CanvasItem[];
  branches: Map<string, string>;
  info: Map<string, LoadoutInfo>;
}

const valid = (d: unknown): d is PromptMapData => {
  const o = d as PromptMapData;
  return !!o && Array.isArray(o.features) && Array.isArray(o.prompts) && Array.isArray(o.segs);
};

/**
 * The graph data in a text: a page's JSON, a .json file, or the map's .html page (its
 * `const DATA={…};` line). Null when there's none.
 */
export function parseLoadout(text: string): PromptMapData | null {
  const tries: string[] = [];
  const line = text.split("\n").find((l) => l.trimStart().startsWith("const DATA="));
  if (line) tries.push(line.trimStart().slice("const DATA=".length).trim().replace(/;$/, ""));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(text.slice(start, end + 1));
  for (const t of tries) {
    try {
      const d = JSON.parse(t);
      if (valid(d)) return d;
    } catch {
      // Next way.
    }
  }
  return null;
}

/** "2026-10-28T13:23:39" as local time (the map's times are wall-clock times). */
function localMs(t: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) return Date.parse(t);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime();
}

/** The loadout as canvas items, each on its feature's branch. */
export function loadoutFrom(d: PromptMapData, title: string): Loadout {
  const label = new Map(d.features.map((f) => [f.id, f.label]));
  const items: CanvasItem[] = [];
  const branches = new Map<string, string>();
  const info = new Map<string, LoadoutInfo>();
  const parts = new Map<number, string[]>();
  const offset = new Map<number, number>();
  d.segs.forEach((s, i) => {
    const p = d.prompts[s.p];
    if (!p || typeof s.text !== "string") return;
    const key = `g${i}`;
    const ms = localMs(p.t);
    const text = s.text.replace(/^\[Artifact comment\]\n/, "").replace(/^\n+|\n+$/g, "");
    const start = offset.get(s.p) ?? 0;
    offset.set(s.p, start + s.text.length);
    items.push({
      key,
      text,
      label: shortLabel(text) || "…",
      ms,
      when: "stamp",
      day: dayKey(new Date(ms)),
      section: p.thread ?? "",
      tags: [],
      kind: "line",
      order: i,
    });
    branches.set(key, label.get(s.f) ?? s.f);
    (parts.get(s.p) ?? parts.set(s.p, []).get(s.p)!).push(key);
    info.set(key, { prompt: s.p, promptCount: d.prompts.length, thread: p.thread ?? "", full: p.text, start, end: start + s.text.length, parts: [] });
  });
  for (const keys of parts.values()) for (const k of keys) info.get(k)!.parts = keys;
  return { title, items, branches, info };
}

/** The page text a loadout is saved as. */
export const loadoutPageContent = (d: PromptMapData) => ({
  type: "doc",
  content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: JSON.stringify(d) }] }],
});

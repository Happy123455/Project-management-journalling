// One graph format for Canvas, the mind map, voice graphs and project exports: the prompt map's
// { features, prompts, segs } (src/lib/canvasLoadout.ts). Features are branches, prompts are what
// was said or written (a talk, a note, a chat message), segs are its parts, each on a branch.
import type { MindMap, MindNode } from "./mindmap";
import { shortLabel } from "./canvas";
import type { PromptMapData } from "./canvasLoadout";

/** "2026-11-14T09:05:00", local wall-clock time (what the graph format uses). */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * A talk's ideas: its sentences, short ones joined to the next (a node per thought, not per
 * "okay."), very long ones split at a comma or a word near 280 characters.
 */
export function splitIdeas(text: string, maxLen = 280): string[] {
  const sentences = (text.replace(/\s+/g, " ").match(/[^.!?।]+[.!?।]*["')\]]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let carry = "";
  for (const s of sentences) {
    const joined = carry ? `${carry} ${s}` : s;
    if (words(joined) < 6) {
      carry = joined;
      continue;
    }
    carry = "";
    let rest = joined;
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen);
      const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
      const cut = at > maxLen / 2 ? at + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : maxLen;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  if (carry) {
    if (out.length && words(carry) < 3) out[out.length - 1] += ` ${carry}`;
    else out.push(carry);
  }
  return out;
}

export const emptyGraph = (title: string): PromptMapData => ({ title, features: [], prompts: [], segs: [] });

/** A free branch id ("f1", "f2", …). */
export function nextFeatureId(d: PromptMapData): string {
  const used = new Set(d.features.map((f) => f.id));
  let n = d.features.length + 1;
  while (used.has(`f${n}`)) n++;
  return `f${n}`;
}

/** Adds branches by label (an existing branch with the same label is reused); their ids, in order. */
export function addFeatures(d: PromptMapData, labels: string[]): { graph: PromptMapData; ids: string[] } {
  const graph = { ...d, features: [...d.features] };
  const ids = labels.map((raw) => {
    const label = raw.trim().slice(0, 60) || "Ideas";
    const same = graph.features.find((f) => f.label.toLowerCase() === label.toLowerCase());
    if (same) return same.id;
    const id = nextFeatureId(graph);
    graph.features.push({ id, label });
    return id;
  });
  return { graph, ids };
}

/**
 * Adds one talk (or note, or message) as a prompt whose parts are `ideas`, each on the branch
 * `branchIds[i]`. The parts join back into the prompt's text exactly (Canvas shows where each
 * part sits in it).
 */
export function addPrompt(d: PromptMapData, p: { at: Date; thread: string; ideas: string[]; branchIds: string[] }): PromptMapData {
  const index = d.prompts.length;
  const parts = p.ideas.map((t, i) => (i < p.ideas.length - 1 ? `${t} ` : t));
  return {
    ...d,
    prompts: [...d.prompts, { t: localIso(p.at), text: parts.join(""), thread: p.thread }],
    segs: [...d.segs, ...parts.map((text, k) => ({ p: index, f: p.branchIds[k], k, text }))],
  };
}

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);

const dayOf = (t: string) => (/^\d{4}-\d{2}-\d{2}/.exec(t)?.[0] ?? "");

/**
 * A graph as a mind map (read-only): the graph's name in the middle, its branches around it, each
 * part under its branch. Days come from the prompts' times, so the mind map's replay slider plays
 * the graph as it grew.
 */
export function mindMapFromGraph(d: PromptMapData, title: string): MindMap {
  const root = "me";
  const nodes: MindNode[] = [{ id: root, label: title, kind: "project", parent: null, firstSeenDay: "", lastSeenDay: "", weight: 1, days: [] }];
  const byFeature = new Map<string, MindNode>();
  for (const f of d.features) {
    const node: MindNode = { id: `f:${f.id}`, label: f.label, kind: "theme", parent: root, firstSeenDay: "", lastSeenDay: "", weight: 0, days: [] };
    byFeature.set(f.id, node);
    nodes.push(node);
  }
  d.segs.forEach((s, i) => {
    const prompt = d.prompts[s.p];
    const branch = byFeature.get(s.f);
    if (!prompt || !branch || typeof s.text !== "string") return;
    const day = dayOf(prompt.t);
    const text = s.text.replace(/^\[Artifact comment\]\n/, "").trim();
    if (!text) return;
    nodes.push({ id: `s:${i}`, label: clip(shortLabel(text) || text), kind: "idea", parent: branch.id, firstSeenDay: day, lastSeenDay: day, weight: 1, days: day ? [day] : [] });
    branch.weight++;
    if (day) {
      if (!branch.days.includes(day)) branch.days.push(day);
      if (!branch.firstSeenDay || day < branch.firstSeenDay) branch.firstSeenDay = day;
      if (day > branch.lastSeenDay) branch.lastSeenDay = day;
    }
  });
  // Branches with nothing on them are left out.
  const kept = nodes.filter((n) => n.id === root || n.kind !== "theme" || n.weight > 0);
  const processedDays = [...new Set(kept.flatMap((n) => n.days))].sort();
  return { nodes: kept, links: [], processedDays };
}

// Item 12: the live graph beside a talk + type box. What the person has said and typed so far
// becomes ideas, tasks, questions and decisions with links, plus what's still unfinished. It's
// asked for in small steps (a pause after a sentence, or every few seconds of quiet), from the
// cheap model (the Mac's local model when it runs, else Flash-Lite), and each answer updates the
// last graph, so ids stay put and the picture grows instead of jumping.
import { askAi } from "./client";
import { improvePrompt, type Improved } from "./improve";

export type NodeKind = "topic" | "idea" | "task" | "question" | "decision";
export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** open: still being explained / not decided; done: settled. */
  state: "open" | "done";
}
export interface TalkGraph {
  nodes: GraphNode[];
  edges: { from: string; to: string }[];
  /** Short notes on what's unfinished ("still explaining the budget", "task: who books?"). */
  unfinished: string[];
}

export const EMPTY_GRAPH: TalkGraph = { nodes: [], edges: [], unfinished: [] };
const KINDS: NodeKind[] = ["topic", "idea", "task", "question", "decision"];

/** A graph from stored or model JSON, cleaned: known kinds, unique ids, edges between real nodes. */
export function parseGraph(raw: unknown): TalkGraph {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return EMPTY_GRAPH;
    }
  }
  const g = (v ?? {}) as Partial<Record<keyof TalkGraph, unknown>>;
  const seen = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
    const x = n as Partial<GraphNode>;
    const id = String(x?.id ?? "").trim();
    const label = String(x?.label ?? "").trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: label.slice(0, 80), kind: KINDS.includes(x.kind as NodeKind) ? (x.kind as NodeKind) : "idea", state: x.state === "done" ? "done" : "open" });
    if (nodes.length >= 40) break;
  }
  const edges = (Array.isArray(g.edges) ? g.edges : [])
    .map((e) => ({ from: String((e as { from?: unknown })?.from ?? ""), to: String((e as { to?: unknown })?.to ?? "") }))
    .filter((e) => e.from !== e.to && seen.has(e.from) && seen.has(e.to))
    .slice(0, 80);
  const unfinished = (Array.isArray(g.unfinished) ? g.unfinished : []).map((u) => String(u).trim()).filter(Boolean).slice(0, 8);
  return { nodes, edges, unfinished };
}

export const GRAPH_SYSTEM =
  "You turn what a person is typing and saying (a rough, growing explanation of what they want) into a small graph. " +
  "Nodes: one 'topic' (what it's all about), then ideas, tasks (things to do), questions (things not yet answered) and decisions. Labels of 2–6 words in their words. " +
  "Edges link related nodes (topic to its parts, a task to the idea it serves). state 'open' when it's still being explained or not decided, 'done' when settled. " +
  "unfinished: up to 5 short notes on what they haven't finished explaining or deciding, like 'still explaining the budget' or 'task: who books the hall?'. " +
  "You get the previous graph: keep its ids for the same things, change labels only when the meaning changed, add new ones, drop only what they took back. At most 25 nodes. " +
  'Reply as JSON: {"nodes":[{"id","label","kind","state"}],"edges":[{"from","to"}],"unfinished":[…]}.';

const SCHEMA = {
  type: "object",
  properties: {
    nodes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, kind: { type: "string", enum: KINDS }, state: { type: "string", enum: ["open", "done"] } }, required: ["id", "label", "kind", "state"] } },
    edges: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
    unfinished: { type: "array", items: { type: "string" } },
  },
  required: ["nodes", "edges", "unfinished"],
};

type Ask = typeof askAi;

/** The graph for the text so far, updating `prev`. */
export async function graphFor(text: string, prev: TalkGraph, ask: Ask = askAi): Promise<TalkGraph> {
  const r = await ask({
    task: "chat",
    system: GRAPH_SYSTEM,
    text: `Previous graph:\n${JSON.stringify(prev)}\n\nWhat they've typed and said so far:\n${text.slice(-6000)}`,
    schema: SCHEMA,
    maxTokens: 1800,
  });
  const g = parseGraph(r.json ?? r.text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!g.nodes.length) throw new Error("No graph in the answer.");
  return g;
}

/** Changed enough since the last graph to ask again: a finished sentence, or 40+ new letters. */
export function worthUpdating(text: string, last: string): boolean {
  const t = text.trim();
  if (!t || t === last.trim()) return false;
  if (Math.abs(t.length - last.trim().length) >= 40) return true;
  return /[.?!\n]$/.test(t) && t.length > last.trim().length + 8;
}

export const MAKE_SYSTEM =
  "You turn a person's rough talk-and-type session into one clear, organised prompt for an AI. They know what they want but aren't good at explaining: " +
  "they jump around, repeat themselves and leave out small words. Gather everything they said into a logical order (goal, context, details, constraints, what the answer should look like), " +
  "fix spelling and grammar, fill in missing words so it reads naturally, and merge repeats. Keep their meaning, intent, tone and every detail; do NOT add new requirements, facts or examples. " +
  "Where something is still undecided, keep it as an open question in the prompt rather than deciding it. " +
  "Words inside {single curly braces} describe a word the writer couldn't find: replace each with the best word. Markers like ⟦F1⟧ are fields: keep each exactly once. " +
  'Reply as JSON: {"improved": the organised prompt, "note": one short sentence on what you changed, "added": the words you added that were not in the original}.';

/** "Make my prompt": the stronger model (Gemini Pro with the usual fallback), same rules as ✨ Improve. */
export const makeMyPrompt = (text: string, ask?: Ask): Promise<Improved> => improvePrompt(text, { system: MAKE_SYSTEM, task: "organise", provider: "gemini", ask });

/** Positions for drawing: the topic in the middle, the rest on rings by kind, in a w×h box. */
export function layoutGraph(g: TalkGraph, w: number, h: number): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const cx = w / 2;
  const cy = h / 2;
  const topics = g.nodes.filter((n) => n.kind === "topic");
  const rest = g.nodes.filter((n) => n.kind !== "topic");
  topics.forEach((n, i) => pos.set(n.id, { x: cx + (i - (topics.length - 1) / 2) * 120, y: cy }));
  // Order by kind so like things sit together around the ring.
  const order: NodeKind[] = ["idea", "task", "question", "decision"];
  const ring = [...rest].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const inner = Math.min(ring.length, 10);
  ring.forEach((n, i) => {
    const outer = i >= inner;
    const count = outer ? ring.length - inner : inner;
    const k = outer ? i - inner : i;
    const a = (k / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2 + (outer ? Math.PI / count : 0);
    const rx = (outer ? 0.46 : 0.3) * w;
    const ry = (outer ? 0.44 : 0.3) * h;
    pos.set(n.id, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  });
  return pos;
}

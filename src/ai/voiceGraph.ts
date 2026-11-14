// A talk becomes a graph: its ideas (sentences) are placed on branches by the decision models
// (src/ai/decide.ts: "Graph node placement", tunable in ⚖️), and saved as "Graph · <name>" in the
// one graph format, so Canvas and the mind map open it. A new graph gets its first branches from
// the talk; ideas the placement isn't sure about are grouped into new branches, never forced.
import type { JournalStore } from "../store";
import { GRAPH_PREFIX, loadoutPageContent, parseLoadout, type PromptMapData } from "../lib/canvasLoadout";
import { addFeatures, addPrompt, emptyGraph, splitIdeas } from "../lib/graphFormat";
import { docText } from "../lib/words";
import { DECIDE_MODELS, geminiJson, placeNodes, placementConfig } from "./decide";

const SYSTEM = "You organise spoken ideas into a project mind map. Branch names are 1 to 4 words, specific to what was said (not 'Misc' or 'Other'), in the talk's language.";

/** The graph saved under `name`, or null. */
export async function loadGraph(store: JournalStore, name: string): Promise<PromptMapData | null> {
  const page = await store.getPage(`${GRAPH_PREFIX}${name}`);
  if (!page) return null;
  const first = page.content?.content?.[0];
  return parseLoadout(first?.type === "codeBlock" ? first.content?.[0]?.text ?? "" : docText(page.content));
}

/** Names of the saved graphs (without the "Graph · " part). */
export async function graphNames(store: JournalStore): Promise<string[]> {
  return (await store.pageNames()).filter((n) => n.startsWith(GRAPH_PREFIX)).map((n) => n.slice(GRAPH_PREFIX.length)).sort();
}

/** First branches for a new graph, from the whole talk. */
export async function proposeBranches(ideas: string[], fetchImpl?: typeof fetch): Promise<string[]> {
  const schema = { type: "object", properties: { branches: { type: "array", items: { type: "string" } } }, required: ["branches"] };
  const text = `Name the 2 to 7 main branches of this talk's mind map.\n\nThe talk, idea by idea:\n${ideas.map((t, i) => `${i}. ${t}`).join("\n").slice(0, 20_000)}`;
  const raw = (await geminiJson(DECIDE_MODELS, [{ role: "user", parts: [{ text }] }], schema, { system: SYSTEM, fetchImpl })) as { branches?: unknown };
  const out = (Array.isArray(raw.branches) ? raw.branches : []).map((b) => String(b).trim().slice(0, 60)).filter(Boolean);
  return [...new Set(out)].slice(0, 7);
}

/** New branches for ideas that fit none of the existing ones: each idea's branch label, in order. */
export async function groupIdeas(ideas: string[], existing: string[], fetchImpl?: typeof fetch): Promise<string[]> {
  const schema = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, branch: { type: "string" } }, required: ["i", "branch"] } } }, required: ["items"] };
  const text =
    `These ideas don't fit the map's branches${existing.length ? ` (${existing.join(", ")})` : ""}. Group them under as few new branches as make sense; give each idea's branch name, keeping its i.\n\n` +
    ideas.map((t, i) => `${i}. ${t}`).join("\n");
  const raw = (await geminiJson(DECIDE_MODELS, [{ role: "user", parts: [{ text }] }], schema, { system: SYSTEM, fetchImpl })) as { items?: { i?: number; branch?: string }[] };
  const by = new Map((raw.items ?? []).map((x) => [Number(x.i), String(x.branch ?? "").trim()]));
  return ideas.map((_, i) => by.get(i) || "New ideas");
}

export interface VoiceGraphResult {
  title: string;
  graph: PromptMapData;
  ideas: number;
  /** Branches this talk added. */
  newBranches: string[];
}

/** Adds a talk to the graph `name` (made if new) and saves it. */
export async function buildVoiceGraph(
  store: JournalStore,
  opts: { name: string; transcript: string; at: Date; actor?: string; thread?: string; fetchImpl?: typeof fetch },
): Promise<VoiceGraphResult> {
  const name = opts.name.trim().slice(0, 60) || "Voice";
  const ideas = splitIdeas(opts.transcript);
  if (!ideas.length) throw new Error("Nothing was said to put in the graph.");
  let graph = (await loadGraph(store, name)) ?? emptyGraph(name);
  const before = new Set(graph.features.map((f) => f.id));
  if (!graph.features.length) graph = addFeatures(graph, await proposeBranches(ideas, opts.fetchImpl)).graph;
  // Where each idea goes (null: no branch is a sure fit).
  const placed = graph.features.length ? await placeNodes(ideas, graph.features, await placementConfig(store), opts.fetchImpl) : ideas.map(() => null);
  const loose = placed.flatMap((b, i) => (b ? [] : [i]));
  if (loose.length) {
    const labels = await groupIdeas(
      loose.map((i) => ideas[i]),
      graph.features.map((f) => f.label),
      opts.fetchImpl,
    );
    const added = addFeatures(graph, labels);
    graph = added.graph;
    loose.forEach((i, k) => (placed[i] = added.ids[k]));
  }
  graph = addPrompt(graph, { at: opts.at, thread: opts.thread ?? "🎙️ Voice", ideas, branchIds: placed as string[] });
  const title = `${GRAPH_PREFIX}${name}`;
  const actor = opts.actor ?? "Gemini";
  const page = await store.ensurePage(title, actor);
  await store.savePage({ id: page.id, content: loadoutPageContent(graph), plainText: `Graph: ${name} (${graph.segs.length} nodes)`, actor });
  return { title, graph, ideas: ideas.length, newBranches: graph.features.filter((f) => !before.has(f.id)).map((f) => f.label) };
}

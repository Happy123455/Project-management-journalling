import { askAi } from "../ai/client";
import { loadMap, projectMapPage } from "../lib/mindmap";
import { byTime, fingerprint, itemsText, shortWhen, type CanvasItem } from "../lib/canvas";
import type { JournalStore } from "../store";

/**
 * What the canvas keeps: the AI's topics (which branch each line is on) and saved summaries, per
 * note, in one page ("Canvas data") so they sync: topics sorted by the Mac's local model show on
 * the phone too.
 */
export const CANVAS_PAGE = "Canvas data";

export interface SavedSummary {
  /** Fingerprint of the text it summarises: a changed branch gets a fresh summary. */
  h: string;
  text: string;
  by: string;
  at: string;
}
export interface NoteCanvasData {
  /** Item key → topic name. */
  topics?: Record<string, string>;
  topicsBy?: string;
  topicsAt?: string;
  summaries?: Record<string, SavedSummary>;
}
type AllData = Record<string, NoteCanvasData>;

async function loadAll(store: JournalStore): Promise<AllData> {
  try {
    const page = await store.getPage(CANVAS_PAGE);
    const text = page?.content?.content?.[0]?.content?.[0]?.text;
    const data = text ? JSON.parse(text) : {};
    return data && typeof data === "object" ? (data as AllData) : {};
  } catch {
    return {};
  }
}

export async function loadCanvasData(store: JournalStore, noteKey: string): Promise<NoteCanvasData> {
  return (await loadAll(store))[noteKey] ?? {};
}

/** Changes one note's data (read fresh, so the other notes' data and the other device's saves stay). */
export async function updateCanvasData(store: JournalStore, noteKey: string, change: (d: NoteCanvasData) => NoteCanvasData, actor: string): Promise<NoteCanvasData> {
  const all = await loadAll(store);
  const next = change(all[noteKey] ?? {});
  all[noteKey] = next;
  const page = await store.ensurePage(CANVAS_PAGE, actor);
  const content = { type: "doc", content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: JSON.stringify(all) }] }] };
  await store.savePage({ id: page.id, content, plainText: `Canvas data for ${Object.keys(all).length} notes`, actor });
  return next;
}

// ───────────── Topics ─────────────

const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    topics: { type: "array", items: { type: "object", properties: { name: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, required: ["name", "ids"] } },
  },
  required: ["topics"],
};

const TOPIC_SYSTEM = `You sort the lines of one person's journal note into topics, like the branches of a mind map.
- Lines about the same feature, problem, person or idea go in one topic, even when written on different days.
- Topic names are 1-4 words, in the writer's own words where possible (e.g. "Sync clashes", "Deadline bar", "Meme library").
- Put EVERY line id in exactly one topic. Use the ids exactly as given.
Answer with JSON only.`;

// Small batches keep each answer well inside the local model's time limit.
const BATCH = 40;

/**
 * Asks the AI (the local model on the Mac, else the cloud one set in Settings) to sort the lines
 * into topics. Lines already sorted keep their topic; only `items` not in `known` are sent, in
 * batches, each batch told the topics so far so names stay the same.
 */
export async function sortIntoTopics(
  store: JournalStore,
  title: string,
  items: CanvasItem[],
  known: Record<string, string>,
  onProgress?: (done: number, total: number, by?: string) => void,
): Promise<{ topics: Record<string, string>; by: string }> {
  const todo = [...items].filter((it) => !known[it.key]).sort(byTime);
  const topics = { ...known };
  // The project's own mind map (if it has one) suggests names that already mean something.
  const hints = new Set<string>(Object.values(known));
  try {
    const map = await loadMap(store, projectMapPage(title), title);
    map.nodes.filter((n) => n.parent === "me").forEach((n) => hints.add(n.label));
  } catch {
    // No map: fine.
  }
  let by = "";
  const total = Math.ceil(todo.length / BATCH);
  for (let b = 0; b < total; b++) {
    const batch = todo.slice(b * BATCH, (b + 1) * BATCH);
    const ids = new Map(batch.map((it, i) => [`L${i + 1}`, it.key]));
    const lines = batch.map((it, i) => `L${i + 1} | ${shortWhen(it.ms)} | ${it.text.replace(/\s+/g, " ").slice(0, 240)}`).join("\n");
    const names = [...new Set([...hints, ...Object.values(topics)])].slice(0, 30);
    const answer = await askAi<{ topics?: { name?: unknown; ids?: unknown }[] }>({
      task: "describe",
      system: TOPIC_SYSTEM,
      text:
        `NOTE: ${title}\n` +
        (names.length ? `Topics already in use (reuse a name when a line fits; add a new topic only when needed): ${names.join(", ")}\n` : "") +
        `Make between 3 and 12 topics in all.\n\nLINES (id | written | text):\n${lines}`,
      schema: TOPIC_SCHEMA,
      maxTokens: 4096,
    });
    by = answer.actor;
    for (const t of answer.json?.topics ?? []) {
      const name = typeof t?.name === "string" ? t.name.trim().slice(0, 40) : "";
      if (!name || !Array.isArray(t.ids)) continue;
      for (const id of t.ids) {
        const key = typeof id === "string" ? ids.get(id.trim()) : undefined;
        if (key && !topics[key]) topics[key] = name;
      }
    }
    // A line the AI skipped still gets a home.
    for (const key of ids.values()) if (!topics[key]) topics[key] = "Other";
    onProgress?.(b + 1, total, by);
  }
  return { topics, by };
}

// ───────────── Summaries ─────────────

export type SummaryScope = { kind: "root"; title: string } | { kind: "branch"; name: string } | { kind: "item"; branch: string };

/** One paragraph about the lines in scope, from the AI. */
export async function summarize(scope: SummaryScope, items: CanvasItem[], noteTitle: string): Promise<{ text: string; by: string }> {
  const text = itemsText(items, scope.kind === "item" ? 6000 : 11_000);
  const ask =
    scope.kind === "item"
      ? `Below is one entry from the journal note "${noteTitle}" (topic: ${scope.branch}). In 1 to 3 plain sentences, say what it is about and what the writer wants or decided.`
      : scope.kind === "branch"
        ? `Below are the journal lines on the topic "${scope.name}" from the note "${noteTitle}", oldest first, each with when it was written. In ONE paragraph of 3 to 6 sentences, say what the writer wants, how it changed over time, and what still seems open.`
        : `Below is the journal note "${noteTitle}", oldest first, each line with when it was written. In ONE paragraph of 4 to 7 sentences, give the big picture: the main threads, how they grew over time, and what still seems open.`;
  const answer = await askAi({
    task: "describe",
    system: "You write short, warm, plain-English summaries of someone's own journal, addressed to them as \"you\". No headings, no lists, no preamble.",
    text: `${ask}\n\n${text}`,
    maxTokens: 700,
  });
  const clean = answer.text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return { text: clean, by: answer.actor };
}

export const summaryHash = (items: CanvasItem[]) => fingerprint(items.map((i) => `${i.key}:${i.text}`).join("\n"));

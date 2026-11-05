import { askAi } from "../ai/client";
import { applyGrowth, applyMerges, loadMap, mapSummary, parseGrowth, placeNew, projectMapPage, saveMap, MAP_PAGE, type MindMap } from "../lib/mindmap";
import { projectTag, projectText } from "../lib/projects";
import { countWords, docText } from "../lib/words";
import type { JournalStore, NamedPage } from "../store";

const ATTACH = {
  type: "array",
  items: {
    type: "object",
    properties: {
      existingId: { type: "string" },
      id: { type: "string" },
      newLabel: { type: "string" },
      kind: { type: "string", enum: ["theme", "idea", "person", "project", "feeling", "goal", "task", "question", "decision", "resource"] },
    },
    required: ["existingId", "newLabel", "kind"],
  },
};
const LINKS = { type: "array", items: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] } };
const SCHEMA = {
  type: "object",
  properties: { attach: ATTACH, reinforce: { type: "array", items: { type: "string" } }, link: LINKS },
  required: ["attach", "reinforce", "link"],
};
const TIDY_SCHEMA = {
  type: "object",
  properties: {
    merge: { type: "array", items: { type: "object", properties: { from: { type: "string" }, into: { type: "string" } }, required: ["from", "into"] } },
    lessons: { type: "array", items: { type: "string" } },
  },
  required: ["merge", "lessons"],
};

// ───────────── Skills: the method, kept as pages you can read and change ─────────────

/** The skill pages: the AI reads them every time, and adds what it learns under "Learned". */
export const MAP_SKILL = "Skill · Mind map";
export const PROJECT_SKILL = "Skill · Project mind map";

const MAP_METHOD = `How the mind map grows (the AI follows this every time it reads a note).

- The map is a tree from "Me". It only ever grows: never rebuild, rename or move what's there.
- Read each note on its own. Pick the few things that matter in it: themes, ideas, people, projects, feelings.
- Hang each new thing under the closest existing node, not under "Me", unless it's a new broad theme.
- Broad themes (Health, Work, Family…) sit under Me; specifics go one or two levels deeper, like branches and twigs.
- A thing that comes back is reinforced, not added again. Same idea, different words = the same node.
- Labels are 1-4 words, in the note's own words.
- Link two branches only when the note clearly ties them together.

Learned
`;

const PROJECT_METHOD = `How a project's mind map is built (the AI follows this for every project).

- Read ONLY the project's own text: its page, and the box or section written for it in daily notes. Nothing else.
- The root is the project. Its first branches are the parts that exist in the text, from: Goal, Tasks, Ideas, Questions, Decisions, People, Resources.
- Each task, idea, question… hangs under its branch; sub-steps hang under their task.
- Labels are 1-6 words, in the text's own words. Done tasks stay, marked "✓".
- When the map already has something, reinforce it; only add what's new. Never move or rebuild.

Learned
`;

async function skillText(store: JournalStore, title: string, method: string): Promise<string> {
  const page = await store.getPage(title);
  if (page) return docText(page.content).slice(0, 4000);
  // First use: the skill becomes a page, so the method can be read and changed like any note.
  const created = await store.ensurePage(title);
  const content = { type: "doc", content: method.split("\n").map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })) };
  await store.savePage({ id: created.id, content, plainText: method, actor: "me" });
  return method;
}

/** Adds a few short lessons under "Learned" on a skill page (no repeats; the newest 20 kept). */
async function learn(store: JournalStore, title: string, lessons: string[], actor: string) {
  const fresh = lessons.map((l) => l.trim().replace(/^[-•]\s*/, "").slice(0, 160)).filter(Boolean).slice(0, 3);
  if (!fresh.length) return;
  const page = await store.getPage(title);
  if (!page) return;
  const text = docText(page.content);
  const novel = fresh.filter((l) => !text.toLowerCase().includes(l.toLowerCase()));
  if (!novel.length) return;
  const blocks = [...(page.content.content ?? []), ...novel.map((l) => ({ type: "paragraph", content: [{ type: "text", text: `- ${l}` }] }))];
  // Only the newest 20 learned lines stay.
  const learnedAt = blocks.findIndex((b) => docText(b).trim() === "Learned");
  const learned = learnedAt >= 0 ? blocks.slice(learnedAt + 1).filter((b) => docText(b).trim()) : [];
  const kept = learnedAt >= 0 ? [...blocks.slice(0, learnedAt + 1), ...learned.slice(-20)] : blocks;
  const content = { ...page.content, content: kept };
  await store.savePage({ id: page.id, content, plainText: docText(content), actor });
}

// ───────────── Growing ─────────────

const SYSTEM = `You grow a personal mind map from one day of someone's journal. The map's root is "Me" (id "me").
Follow the SKILL below exactly. You may only:
- attach: add a new short label as a child of an EXISTING node id (or of a node you add earlier in this answer: give it an "id" like "n1" and use that as existingId), at most 12;
- reinforce: list existing ids this day clearly touches again;
- link: connect two ids that this day relates.
Use the ids exactly as given. Answer with JSON only.`;

const PROJECT_SYSTEM = `You build and grow the mind map of ONE project from its own text only. The map's root is the project (id "me").
Follow the SKILL below exactly. You may only:
- attach: add a label as a child of an EXISTING node id, or of a node you add earlier in this answer (give it an "id" like "n1" and use it as existingId). Build whole branches this way: Goal, Tasks, Ideas… then their items. At most 12 new nodes;
- reinforce: existing ids the text still contains;
- link: connect two ids the text relates.
Use the ids exactly as given. Answer with JSON only.`;

/** Grown again once a note has this many more words than when it was last read. */
const REGROW_WORDS = 80;
/** Every this many days grown, the map is tidied (duplicates folded together) and the skill learns. */
const TIDY_EVERY = 6;

const newId = () => crypto.randomUUID().slice(0, 8);

/**
 * Grows the map from one day's note. A day is read once, and read again when it has grown a lot since
 * (only what's new is added). Returns how many ideas were added, or null if there was nothing to do.
 */
export async function growMap(store: JournalStore, day: string, minWords = 1, force = false): Promise<number | null> {
  const map = await loadMap(store);
  const page = await store.getDay(day);
  const text = page ? docText(page.content) : "";
  const words = countWords(text);
  if (words < minWords) return null;
  const again = map.processedDays.includes(day);
  // Days grown before words were counted: taken as read in full.
  const seen = map.processedWords?.[day] ?? (again ? words : 0);
  if (again && !force && words - seen < REGROW_WORDS) return null;
  const skill = await skillText(store, MAP_SKILL, MAP_METHOD);
  const answer = await askAi<unknown>({
    task: "grammar",
    system: `${SYSTEM}\n\nSKILL:\n${skill}`,
    text: `MAP (id, label, kind, weight):\n${mapSummary(map)}\n\n${again ? "This day was read before: reinforce what's there, add only what's new.\n\n" : ""}JOURNAL ${day}:\n${text.slice(0, 12000)}`,
    schema: SCHEMA,
    maxTokens: 2048,
  });
  let next = placeNew(applyGrowth(map, parseGrowth(answer.json), day, newId, again));
  next = { ...next, processedWords: { ...map.processedWords, [day]: words } };
  await saveMap(store, next, answer.actor);
  if (!again && next.processedDays.length % TIDY_EVERY === 0) await tidyMap(store).catch(() => {});
  return next.nodes.length - map.nodes.length;
}

/** Notes not read yet (or grown a lot since), oldest first: what "inspect each note" still has to do. */
export async function pendingDays(store: JournalStore, today: string, minWords = 50): Promise<string[]> {
  const [map, counts] = await Promise.all([loadMap(store), store.wordCounts("0000-01-01", today)]);
  return Object.entries(counts)
    .filter(([d, n]) => d <= today && n >= minWords && (!map.processedDays.includes(d) || n - (map.processedWords?.[d] ?? n) >= REGROW_WORDS))
    .map(([d]) => d)
    .sort();
}

/** Reads the pending notes one by one (up to `limit`), growing the map from each. */
export async function growPending(store: JournalStore, today: string, limit = 3, onProgress?: (done: number, total: number) => void): Promise<number> {
  const days = (await pendingDays(store, today)).slice(0, limit);
  let added = 0;
  for (const [i, d] of days.entries()) {
    added += (await growMap(store, d, 50)) ?? 0;
    onProgress?.(i + 1, days.length);
  }
  return added;
}

const TIDY_SYSTEM = `You keep a mind map tidy without disturbing it. Given its nodes (id, label, kind, weight, parent):
- merge: pairs where "from" is clearly the same thing as "into" (duplicates, synonyms, singular/plural). Keep the older, heavier one as "into". Never merge "me". Be conservative.
- lessons: at most 2 short rules you learned about how THIS person's map should be organised (e.g. "Gym and workouts belong under Health"), to remember next time. Empty if nothing new.
Answer with JSON only.`;

/** Folds duplicate ideas together and lets the skill learn from the map. Returns how many were folded. */
export async function tidyMap(store: JournalStore, pageTitle = MAP_PAGE, skillTitle = MAP_SKILL): Promise<number> {
  const map = await loadMap(store, pageTitle);
  if (map.nodes.length < 4) return 0;
  const rows = map.nodes.map((n) => `${n.id}\t${n.label}\t${n.kind}\tw${n.weight}\t${n.parent ?? "-"}`).join("\n");
  const answer = await askAi<{ merge?: unknown; lessons?: unknown }>({ task: "grammar", system: TIDY_SYSTEM, text: rows.slice(0, 14000), schema: TIDY_SCHEMA, maxTokens: 1024 });
  const merges = parseGrowth({ merge: answer.json?.merge }).merge ?? [];
  const next = applyMerges(map, merges);
  if (next.nodes.length !== map.nodes.length) await saveMap(store, next, answer.actor, pageTitle);
  const lessons = Array.isArray(answer.json?.lessons) ? answer.json!.lessons.filter((l): l is string => typeof l === "string") : [];
  await learn(store, skillTitle, lessons, answer.actor);
  return map.nodes.length - next.nodes.length;
}

// ───────────── A project's own map ─────────────

/** The project's own text only: its page, and its box / section in every note that names it. */
export async function projectSource(store: JournalStore, project: NamedPage): Promise<string> {
  const own = await store.getPage(project.title);
  const parts: string[] = [];
  if (own) parts.push(docText(own.content));
  const refs = [...(await store.references("wikilink", project.title)), ...(await store.references("tag", projectTag(project.title)))];
  const seen = new Set<string>([project.id]);
  for (const ref of refs.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""))) {
    if (seen.has(ref.blockId)) continue;
    seen.add(ref.blockId);
    const text = projectText(ref.content, project.title);
    if (text.trim()) parts.push(`${ref.day ?? ref.title ?? ""}:\n${text}`);
  }
  return parts.join("\n\n").trim();
}

/** Builds (first time) or grows a project's map from its own text; null when the text hasn't changed enough. */
export async function growProjectMap(store: JournalStore, project: NamedPage, force = false): Promise<number | null> {
  const title = projectMapPage(project.title);
  const map: MindMap = await loadMap(store, title, project.title);
  const text = await projectSource(store, project);
  const words = countWords(text);
  if (!words) return null;
  const seen = map.processedWords?.project ?? 0;
  if (!force && map.nodes.length > 1 && Math.abs(words - seen) < 25) return null;
  const skill = await skillText(store, PROJECT_SKILL, PROJECT_METHOD);
  const answer = await askAi<unknown>({
    task: "grammar",
    system: `${PROJECT_SYSTEM}\n\nSKILL:\n${skill}`,
    text: `PROJECT: ${project.title}\nMAP (id, label, kind, weight):\n${mapSummary(map)}\n\nPROJECT TEXT:\n${text.slice(0, 14000)}`,
    schema: SCHEMA,
    maxTokens: 3072,
  });
  const day = new Date().toISOString().slice(0, 10);
  let next = placeNew(applyGrowth(map, parseGrowth(answer.json), day, newId, true));
  next = { ...next, processedWords: { ...map.processedWords, project: words } };
  await saveMap(store, next, answer.actor, title);
  return next.nodes.length - map.nodes.length;
}

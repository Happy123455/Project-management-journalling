import { askAi } from "../ai/client";
import { applyGrowth, loadMap, mapSummary, parseGrowth, saveMap } from "../lib/mindmap";
import { countWords, docText } from "../lib/words";
import type { JournalStore } from "../store";

const SCHEMA = {
  type: "object",
  properties: {
    attach: {
      type: "array",
      items: {
        type: "object",
        properties: {
          existingId: { type: "string" },
          newLabel: { type: "string" },
          kind: { type: "string", enum: ["theme", "idea", "person", "project", "feeling"] },
        },
        required: ["existingId", "newLabel", "kind"],
      },
    },
    reinforce: { type: "array", items: { type: "string" } },
    link: { type: "array", items: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] } },
  },
  required: ["attach", "reinforce", "link"],
};

const SYSTEM = `You grow a personal mind map from one day of someone's journal. The map's root is "Me" (id "me").
Never rebuild or rename anything. You may only:
- attach: add a new short label (1-4 words) as a child of an EXISTING node id, for a theme, idea, person, project or feeling that matters in this day's note (at most 12, prefer fewer);
- reinforce: list existing ids this day clearly touches again;
- link: connect two existing ids that this day relates.
Put broad themes under "me", specifics under the closest existing node. Use the ids exactly as given. Answer with JSON only.`;

/** Grows the map from one day's note (once per day). Returns how many ideas were added, or null if nothing to do. */
export async function growMap(store: JournalStore, day: string, minWords = 1): Promise<number | null> {
  const map = await loadMap(store);
  if (map.processedDays.includes(day)) return null;
  const page = await store.getDay(day);
  const text = page ? docText(page.content) : "";
  if (countWords(text) < minWords) return null;
  const answer = await askAi<unknown>({
    task: "grammar",
    system: SYSTEM,
    text: `MAP (id, label, kind, weight):\n${mapSummary(map)}\n\nJOURNAL ${day}:\n${text.slice(0, 12000)}`,
    schema: SCHEMA,
    maxTokens: 2048,
  });
  const next = applyGrowth(map, parseGrowth(answer.json), day, () => crypto.randomUUID().slice(0, 8));
  await saveMap(store, next, answer.actor);
  return next.nodes.length - map.nodes.length;
}

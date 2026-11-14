// Each day's preview: a sentence or two about the day, written by the Mac's local model (free, on
// the Mac only, a few days at a time while the app is open and you're not typing) and kept on the
// day (its props), so it syncs to the phone and shows at the top of the day's note.
import type { JournalStore } from "../store";
import type { DayPage } from "../store/types";
import { countWords, docText } from "../lib/words";
import { dayKey } from "../lib/timestamp";
import { isTyping } from "../lib/toast";
import { loadYoutubeDay, youtubeLine } from "../lib/youtubeDigest";
import { askLocal, localAvailable } from "./client";
import { loadAiSettings } from "./settings";
import { actorFor } from "./providers";

const MIN_WORDS = 25;

/** A day that should get a (new) preview: enough written, the day over (or late evening), changed since. */
export function needsSnippet(page: Pick<DayPage, "day" | "props">, words: number, now: Date): boolean {
  if (words < MIN_WORDS) return false;
  const today = dayKey(now);
  if (page.day > today || (page.day === today && now.getHours() < 21)) return false;
  const s = page.props.snippet;
  return !s || Math.abs(s.words - words) > Math.max(20, s.words * 0.2);
}

export const SNIPPET_SYSTEM =
  "You write a short preview of one day of someone's journal: one or two plain sentences, at most 35 words, " +
  "saying what the day held (the main things done, met, decided or felt). Write in the journal's own language, " +
  "past tense, no judgement, no quotes, no heading. Answer with the preview only.";

export function cleanSnippet(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^["'“]|["'”]$/g, "").replace(/\s+/g, " ").trim().slice(0, 280);
}

let running = false;

/** Writes previews for recent days that need one (newest first, at most `max` per run). */
export async function writeSnippets(store: JournalStore, now = new Date(), max = 4): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    if (!loadAiSettings().enabled || !(await localAvailable())) return 0;
    const days = (await store.listDays()).filter((d) => d <= dayKey(now)).sort().reverse().slice(0, 14);
    for (const day of days) {
      if (n >= max || document.visibilityState !== "visible") break;
      if (isTyping()) break;
      const page = await store.getDay(day);
      if (!page) continue;
      const text = docText(page.content);
      const words = countWords(text);
      if (!needsSnippet(page, words, now)) continue;
      const yt = await loadYoutubeDay(store, day).catch(() => null);
      const r = await askLocal({ task: "grammar", system: SNIPPET_SYSTEM, text: `${text.slice(0, 6000)}${yt ? `\n\n(YouTube that day: ${youtubeLine(yt)})` : ""}`, maxTokens: 120 });
      const snippet = cleanSnippet(r.text);
      if (!snippet) continue;
      await store.setDayProps(day, { snippet: { text: snippet, at: Date.now(), by: actorFor("local", r.model), words } }, actorFor("local", r.model));
      window.dispatchEvent(new CustomEvent("journal:snippet", { detail: day }));
      n++;
    }
  } finally {
    running = false;
  }
  return n;
}

/** The Mac: previews a little after opening, then every two hours while the app is on screen. */
export function startSnippetWorker(store: JournalStore): () => void {
  let timer = 0;
  const run = () => {
    window.clearTimeout(timer);
    if (document.visibilityState === "visible") void writeSnippets(store).catch(() => {});
    timer = window.setTimeout(run, 2 * 3600_000);
  };
  timer = window.setTimeout(run, 45_000);
  return () => window.clearTimeout(timer);
}

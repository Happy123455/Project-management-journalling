import type { JournalStore } from "./types";
import { thinCutoff } from "./thin";
import { hasPendingEdits } from "../editor/JournalEditor";

const KEY = "journal.thinnedAt";
const DAY = 86_400_000;
/** A while after opening, so starting up and the first sync round come first. */
const START_AFTER_MS = 90_000;
/** Freeing the disk space (VACUUM rewrites the whole file) only after a big thinning. */
const RECLAIM_AFTER = 1000;

function readAt(): number {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Once a day per device, in the background: thins edit history older than a month
 * (store/thin.ts). Never while typing or with the app hidden; tried again later then.
 */
export function startHistoryThinning(store: JournalStore): () => void {
  if (!store.thinHistory) return () => {};
  let timer = 0;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    const typing = !!document.activeElement?.closest?.(".tiptap, .source-text") && hasPendingEdits();
    if (document.hidden || typing) return void (timer = window.setTimeout(run, 60_000));
    if (Date.now() - readAt() < DAY) return;
    try {
      const gone = await store.thinHistory!(thinCutoff());
      try {
        localStorage.setItem(KEY, String(Date.now()));
      } catch {
        // Tried again next start.
      }
      if (gone >= RECLAIM_AFTER && store.reclaimSpace) await store.reclaimSpace().catch(() => {});
      if (gone) console.info(`Edit history: thinned ${gone} old edits`);
    } catch (e) {
      console.warn("Edit history thinning failed", e);
    }
  };
  timer = window.setTimeout(run, START_AFTER_MS);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

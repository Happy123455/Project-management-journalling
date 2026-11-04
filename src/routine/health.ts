import type { JournalStore } from "../store";
import { dayKey } from "../lib/timestamp";
import { entriesIn, type RoutineConfig } from "../lib/routine";
import { currentDoc, loadConfig, writeLog } from "./routineData";

/**
 * Exercise and sleep from Samsung Health. Samsung Health shares them with Android's Health Connect
 * (Samsung Health → Settings → Health Connect), and the phone app reads them from there
 * (MainActivity.kt HealthBridge). Each session becomes ordinary log lines in that day's note,
 * marked "(Samsung Health)", so they sync to the Mac and count like taps.
 */

declare global {
  interface Window {
    JournalHealth?: {
      /** "ready" (access granted), "ask" (installed, no access yet), "update" (Health Connect needs an update) or "unavailable". */
      status(): string;
      askAccess(): void;
      /** Sessions from..to (ms); answered through window.__journalHealth(id, json). */
      read(id: string, from: number, to: number): void;
    };
    __journalHealth?: (id: string, json: string) => void;
  }
}

export interface HealthSession {
  kind: "exercise" | "sleep";
  start: number;
  end: number;
  title?: string;
}

export const healthAvailable = () => {
  try {
    return !!window.JournalHealth && window.JournalHealth.status() !== "unavailable";
  } catch {
    return false;
  }
};

export function askHealthAccess() {
  try {
    window.JournalHealth?.askAccess();
  } catch {
    // An older app without the bridge.
  }
}

const waiting = new Map<string, (json: string) => void>();

function readHealth(from: number, to: number): Promise<HealthSession[] | null> {
  const bridge = window.JournalHealth;
  if (!bridge) return Promise.resolve(null);
  try {
    if (bridge.status() !== "ready") return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  window.__journalHealth = (id, json) => {
    waiting.get(id)?.(json);
    waiting.delete(id);
  };
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => (waiting.delete(id), resolve(null)), 20_000);
    waiting.set(id, (json) => {
      window.clearTimeout(timer);
      try {
        const list = JSON.parse(json) as HealthSession[] | null;
        resolve(Array.isArray(list) ? list.filter((s) => s && (s.kind === "exercise" || s.kind === "sleep") && s.end > s.start) : null);
      } catch {
        resolve(null);
      }
    });
    bridge.read(id, from, to);
  });
}

/** Writes the health app's sessions of the last day and a half that aren't in the notes yet. */
export async function importHealth(store: JournalStore, config: RoutineConfig): Promise<number> {
  if (!config.health) return 0;
  const now = Date.now();
  const sessions = await readHealth(now - 36 * 3_600_000, now);
  if (!sessions?.length) return 0;
  const step = (h: "exercise" | "sleep" | "wake") => config.steps.find((s) => s.health === h);
  const lines: { at: number; item: { icon: string; label: string; id: string }; edge: "start" | "end" | "point" }[] = [];
  for (const s of sessions) {
    if (s.kind === "exercise") {
      const ex = step("exercise");
      if (!ex) continue;
      lines.push({ at: s.start, item: ex, edge: ex.span ? "start" : "point" });
      if (ex.span) lines.push({ at: s.end, item: ex, edge: "end" });
    } else if (s.end - s.start >= 3 * 3_600_000) {
      // A night's sleep (naps don't move bedtime or waking).
      const bed = step("sleep");
      const wake = step("wake");
      if (bed) lines.push({ at: s.start, item: bed, edge: "point" });
      if (wake) lines.push({ at: s.end, item: wake, edge: "point" });
    }
  }
  let added = 0;
  for (const l of lines.sort((a, b) => a.at - b.at)) {
    if (l.at > now) continue;
    const day = dayKey(new Date(l.at));
    const have = entriesIn(await currentDoc(store, day), config);
    // Already there (written before, or logged by hand within a few minutes): leave it.
    if (have.some((e) => e.kind === "step" && e.id === l.item.id && e.edge === l.edge && Math.abs(e.time - l.at) < 5 * 60_000)) continue;
    await writeLog(store, l.item, l.edge, new Date(l.at), { note: "Samsung Health", actor: "Samsung Health" });
    added++;
  }
  return added;
}

let last = 0;

/** Phone: reads the health app when the journal opens or comes back to the front (at most every 15 minutes). */
export function startHealthSync(store: JournalStore): () => void {
  if (!window.JournalHealth) return () => {};
  const run = () => {
    if (document.visibilityState === "hidden" || Date.now() - last < 15 * 60_000) return;
    last = Date.now();
    void loadConfig(store).then((c) => importHealth(store, c)).catch(() => {});
  };
  const t = window.setTimeout(run, 4000);
  document.addEventListener("visibilitychange", run);
  return () => {
    window.clearTimeout(t);
    document.removeEventListener("visibilitychange", run);
  };
}

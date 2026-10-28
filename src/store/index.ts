import { MemoryStore } from "./memoryStore";
import type { JournalStore } from "./types";

export type { DayPage, FileRecord, JournalEvent, JournalStore, LinkKind, NamedPage, Reference, SearchHit } from "./types";

const inTauri = () => "__TAURI_INTERNALS__" in window;

/** SQLite inside the app; a localStorage store when running in a plain browser. */
export async function openStore(): Promise<JournalStore> {
  if (inTauri()) {
    const { SqliteStore } = await import("./sqliteStore");
    return SqliteStore.open();
  }
  return new MemoryStore(window.localStorage);
}

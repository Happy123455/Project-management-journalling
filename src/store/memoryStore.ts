import { extractLinks } from "../lib/links";
import { deviceId, newId } from "./ids";
import type { DayPage, JournalEvent, JournalStore, SaveDayInput } from "./types";

interface Snapshot {
  pages: Record<string, DayPage>;
  events: JournalEvent[];
  links: { from: string; target: string; kind: "wikilink" | "tag" }[];
}

const KEY = "dynamic-journal.memory-store";

/**
 * Store used in a plain browser (`npm run dev`) and in tests.
 * The real app uses SqliteStore; both follow the same rules.
 */
export class MemoryStore implements JournalStore {
  private data: Snapshot;

  constructor(private storage?: Pick<Storage, "getItem" | "setItem">, private device = deviceId(storage)) {
    const raw = storage?.getItem(KEY);
    this.data = raw ? JSON.parse(raw) : { pages: {}, events: [], links: [] };
  }

  async getDay(day: string) {
    return this.data.pages[day] ?? null;
  }

  async saveDay({ day, content, plainText, actor = "me" }: SaveDayInput) {
    const now = new Date().toISOString();
    const existing = this.data.pages[day];
    const after = JSON.stringify(content);
    const page: DayPage = { id: existing?.id ?? newId(), day, content, updatedAt: now };
    if (existing && JSON.stringify(existing.content) === after) return existing;

    const last = [...this.data.events].reverse().find((e) => e.blockId === page.id);
    this.data.events.push({
      id: newId(),
      deviceId: this.device,
      actor,
      blockId: page.id,
      op: existing ? "update" : "create",
      before: existing ? JSON.stringify(existing.content) : null,
      after,
      parentEventIds: last ? [last.id] : [],
      createdAt: now,
    });

    const { wikilinks, tags } = extractLinks(plainText);
    this.data.links = this.data.links.filter((l) => l.from !== page.id);
    wikilinks.forEach((target) => this.data.links.push({ from: page.id, target, kind: "wikilink" }));
    tags.forEach((target) => this.data.links.push({ from: page.id, target, kind: "tag" }));

    this.data.pages[day] = page;
    this.storage?.setItem(KEY, JSON.stringify(this.data));
    return page;
  }

  async listDays() {
    return Object.keys(this.data.pages).sort().reverse();
  }

  async eventsFor(blockId: string) {
    return this.data.events.filter((e) => e.blockId === blockId);
  }
}

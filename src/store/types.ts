import type { JSONContent } from "@tiptap/react";

/** A daily page. Pages are blocks of type "day"; child blocks come later. */
export interface DayPage {
  id: string;
  day: string; // YYYY-MM-DD
  content: JSONContent;
  updatedAt: string;
}

/** One entry in the append-only timeline. Sync and the nexus view build on this. */
export interface JournalEvent {
  id: string;
  deviceId: string;
  actor: string; // "me" or the name of an AI client
  blockId: string;
  op: "create" | "update";
  before: string | null;
  after: string;
  parentEventIds: string[];
  createdAt: string;
}

export interface SaveDayInput {
  day: string;
  content: JSONContent;
  plainText: string;
  actor?: string;
}

export interface JournalStore {
  getDay(day: string): Promise<DayPage | null>;
  saveDay(input: SaveDayInput): Promise<DayPage>;
  listDays(): Promise<string[]>;
  eventsFor(blockId: string): Promise<JournalEvent[]>;
}

import type { JSONContent } from "@tiptap/react";

/** Flags kept in a day block's `props`. */
export interface DayProps {
  /** Written before its day came, so it is shown as a reminder. */
  reminder?: boolean;
  /** The reminder was ticked off with "Done". */
  reminderDone?: boolean;
}

/** A daily page. Pages are blocks of type "day"; child blocks come later. */
export interface DayPage {
  id: string;
  day: string; // YYYY-MM-DD
  content: JSONContent;
  props: DayProps;
  updatedAt: string;
}

/** A named page that [[links]] point to: a topic, a project or a person. Stored as a block of type "page". */
export interface NamedPage {
  id: string;
  title: string;
  content: JSONContent;
  updatedAt: string;
}

export type LinkKind = "wikilink" | "tag";

/** A day or named page that links to a page or carries a tag. */
export interface Reference {
  blockId: string;
  day: string | null;
  title: string | null;
  content: JSONContent;
}

/** An attachment: a photo, video, PDF or any other file. Bytes live under the app data folder. */
export interface FileRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  /** Relative to the app data folder: attachments/<id>/<name>. */
  path: string;
  createdAt: string;
}

export interface SaveFileInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
  actor?: string;
}

/** One entry in the append-only timeline. Sync and the nexus view build on this. */
export interface JournalEvent {
  id: string;
  deviceId: string;
  actor: string; // "me" or the name of an AI client
  blockId: string;
  /** "props" events hold the block's props as before/after instead of its content. */
  op: "create" | "update" | "props";
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
  /** Words written on each day from `from` to `to` (YYYY-MM-DD, inclusive); days with no page are left out. */
  wordCounts(from: string, to: string): Promise<Record<string, number>>;
  eventsFor(blockId: string): Promise<JournalEvent[]>;
  /** Reminder pages not yet marked done, earliest day first. */
  openReminders(): Promise<DayPage[]>;
  /** Mark a day's reminder as done. */
  completeReminder(day: string, actor?: string): Promise<void>;
  /** The named page with this title (any letter case), or null. */
  getPage(title: string): Promise<NamedPage | null>;
  /** The named page with this title, created (with an event) if it doesn't exist yet. */
  ensurePage(title: string, actor?: string): Promise<NamedPage>;
  savePage(input: { id: string; content: JSONContent; plainText: string; actor?: string }): Promise<NamedPage>;
  /** Pages and days that link to `target` or carry the tag `target` (any letter case), newest day first. */
  references(kind: LinkKind, target: string): Promise<Reference[]>;
  /** Every page name known: named pages plus everything [[linked]] so far, for autocomplete. */
  pageNames(): Promise<string[]>;
  /** Stores an attachment (with a create event); the same bytes stored twice give back the first record. */
  saveFile(input: SaveFileInput): Promise<FileRecord>;
  getFile(id: string): Promise<FileRecord | null>;
  fileBytes(id: string): Promise<Uint8Array | null>;
  /** Everything needed to restore the journal: the database (or its JSON in the browser) plus every attachment. */
  exportFiles(): Promise<{ name: string; bytes: Uint8Array }[]>;
}

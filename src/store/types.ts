import type { JSONContent } from "@tiptap/react";
import type { BlockMeta, LocalState, MergePlan, SyncRecord } from "../sync/merge";
import type { ProjectInfo } from "../lib/projects";

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
  /** Extra facts about the page, e.g. { project: { status: "active" } }. */
  props: PageProps;
  updatedAt: string;
}

export interface PageProps {
  project?: ProjectInfo;
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

/** One link for the graph: a day or named page that links to a page or carries a tag. */
export interface GraphLink {
  day: string | null;
  title: string | null;
  target: string;
  kind: LinkKind;
}

/** A day or page whose text contains every search word, or a file whose name does. */
export type SearchHit =
  | { kind: "day" | "page"; blockId: string; day: string | null; title: string | null; text: string }
  | { kind: "file"; file: FileRecord };

/** An edit an AI made (actor is the AI's name), for the "AI changes" list. */
export interface AiChange {
  event: JournalEvent;
  day: string | null;
  title: string | null;
  /** Nothing has changed the note since, so Undo can put back exactly what was there. */
  undoable: boolean;
}

/** One entry in the append-only timeline. Sync and the nexus view build on this. */
export interface JournalEvent {
  id: string;
  deviceId: string;
  actor: string; // "me" or the name of an AI client
  blockId: string;
  /** "props" events hold the block's props as before/after instead of its content. */
  op: "create" | "update" | "props" | "restore";
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
  /** Changes a named page's props (with a "props" event); `undefined` values remove a prop. */
  setPageProps(id: string, patch: Partial<PageProps>, actor?: string): Promise<NamedPage>;
  /** Named pages that are projects, by title. */
  projects(): Promise<NamedPage[]>;
  /** Pages and days that link to `target` or carry the tag `target` (any letter case), newest day first. */
  references(kind: LinkKind, target: string): Promise<Reference[]>;
  /** Edits made by AIs (any actor other than "me"), newest first. */
  aiChanges(limit?: number): Promise<AiChange[]>;
  /**
   * Undoes an AI edit by putting back the note as it was before it (as a new "me" event), when
   * nothing changed the note since. Returns false when it can't.
   */
  undoAiChange(eventId: string): Promise<boolean>;
  /** Every link and tag in the journal, with the day or page it's on. */
  graphLinks(): Promise<GraphLink[]>;
  /** Every page name known: named pages plus everything [[linked]] so far, for autocomplete. */
  pageNames(): Promise<string[]>;
  /** Stores an attachment (with a create event); the same bytes stored twice give back the first record. */
  saveFile(input: SaveFileInput): Promise<FileRecord>;
  getFile(id: string): Promise<FileRecord | null>;
  /** Days and pages containing every search word (any letter case), newest day first, then file-name matches. */
  search(query: string): Promise<SearchHit[]>;
  /** Every stored file, newest first. */
  listFiles(): Promise<FileRecord[]>;
  /** The file an embed points at: "attachments/<id>/<name>", or a bare file name (any letter case, newest first). */
  findFile(ref: string): Promise<FileRecord | null>;
  fileBytes(id: string): Promise<Uint8Array | null>;
  /** A URL that streams the file straight from disk (the app only; the browser store has none). */
  fileSrc?(id: string): Promise<string | null>;
  /** Everything needed to restore the journal: the database (or its JSON in the browser) plus every attachment. */
  exportFiles(): Promise<{ name: string; bytes: Uint8Array }[]>;
  /**
   * Replaces the whole journal with a backup made by exportFiles (from the same kind of store),
   * then records a "restore" event naming where it came from.
   */
  restore(entries: { name: string; bytes: Uint8Array }[], source: string): Promise<void>;

  // ───── Sync (see src/sync) ─────
  /** This install's device id. */
  readonly deviceId: string;
  /** This device's own events (not restores), each with what its block is. */
  syncRecords(): Promise<SyncRecord[]>;
  /** The local id of the day page / named page each meta names, where one exists. */
  localBlockId(meta: BlockMeta): Promise<string | null>;
  /** Known event ids, files, and the newest applied content/props event for these blocks. */
  syncState(blockIds: string[]): Promise<LocalState>;
  /** Adds the plan's events, updates its blocks and stores its files (bytes by hash). Idempotent. */
  applySync(plan: MergePlan, blobs: Map<string, Uint8Array>): Promise<void>;
}

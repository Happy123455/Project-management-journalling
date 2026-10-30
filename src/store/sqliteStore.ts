import Database from "@tauri-apps/plugin-sql";
import { idFromRef } from "../lib/embeds";
import { safeFileName } from "../lib/files";
import { extractLinks, uniqueNames } from "../lib/links";
import { matchText, searchTerms } from "../lib/search";
import { dayKey } from "../lib/timestamp";
import { countWords, docText } from "../lib/words";
import { dayBlockId, deviceId, newId, pageBlockId } from "./ids";
import { Serial } from "./serial";
import type { JSONContent } from "@tiptap/react";
import { fileEventBody, newFileRecord } from "./files";
import { docKey, eventDocument, eventKey, type BlockMeta, type LocalState, type MergePlan, type SyncRecord } from "../sync/merge";
import { withPatch } from "./props";
import type { DayPage, DayProps, FileRecord, JournalEvent, JournalStore, LinkKind, NamedPage, PageProps, Reference, SaveDayInput, SaveFileInput, SearchHit } from "./types";

interface BlockRow {
  id: string;
  day: string;
  content: string;
  props: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  device_id: string;
  actor: string;
  block_id: string;
  op: JournalEvent["op"];
  before: string | null;
  after: string;
  parent_event_ids: string;
  created_at: string;
}

/** Every table that holds journal data (not the migrations table). */
const JOURNAL_TABLES = ["blocks", "block_types", "links", "files", "events"];

/** Replaces every journal table with the one in the backup database at `path` (already quote-escaped). */
export const restoreSql = (path: string) => `ATTACH DATABASE '${path}' AS backup;
BEGIN;
${JOURNAL_TABLES.map((t) => `DELETE FROM main.${t};\nINSERT INTO main.${t} SELECT * FROM backup.${t};`).join("\n")}
COMMIT;
DETACH DATABASE backup;`;

interface FileRow {
  id: string;
  path: string;
  mime: string;
  size: number;
  hash: string;
  created_at: string;
}

const toFile = (r: FileRow): FileRecord => ({
  id: r.id,
  name: r.path.slice(r.path.lastIndexOf("/") + 1),
  mime: r.mime,
  size: r.size,
  hash: r.hash,
  path: r.path,
  createdAt: r.created_at,
});

const toEvent = (r: EventRow): JournalEvent => ({
  id: r.id,
  deviceId: r.device_id,
  actor: r.actor,
  blockId: r.block_id,
  op: r.op,
  before: r.before,
  after: r.after,
  parentEventIds: JSON.parse(r.parent_event_ids),
  createdAt: r.created_at,
});

const toNamed = (r: { id: string; props: string; content: string; updated_at: string }): NamedPage => {
  const { title, ...props } = JSON.parse(r.props);
  return { id: r.id, title, content: JSON.parse(r.content), props, updatedAt: r.updated_at };
};

const toPage = (row: BlockRow): DayPage => ({
  id: row.id,
  day: row.day,
  content: JSON.parse(row.content),
  props: JSON.parse(row.props || "{}"),
  updatedAt: row.updated_at,
});

/** The app's real store: journal.db in the app data folder (schema in src-tauri/src/lib.rs). */
export class SqliteStore implements JournalStore {
  /** Writes run one at a time (see Serial). */
  private writes = new Serial();

  saveDay(input: SaveDayInput) {
    return this.writes.run(() => this.saveDayNow(input));
  }

  completeReminder(day: string, actor?: string) {
    return this.writes.run(() => this.completeReminderNow(day, actor));
  }

  ensurePage(title: string, actor?: string) {
    return this.writes.run(() => this.ensurePageNow(title, actor));
  }

  savePage(input: { id: string; content: JSONContent; plainText: string; actor?: string }) {
    return this.writes.run(() => this.savePageNow(input));
  }

  saveFile(input: SaveFileInput) {
    return this.writes.run(() => this.saveFileNow(input));
  }

  private constructor(private db: Database, private device: string) {
    this.deviceId = device;
  }

  readonly deviceId: string;

  static async open(): Promise<SqliteStore> {
    return new SqliteStore(await Database.load("sqlite:journal.db"), deviceId());
  }

  async getDay(day: string) {
    const rows = await this.db.select<BlockRow[]>(
      "SELECT id, day, content, props, updated_at FROM blocks WHERE type = 'day' AND day = $1",
      [day],
    );
    return rows[0] ? toPage(rows[0]) : null;
  }

  private async saveDayNow({ day, content, plainText, actor = "me" }: SaveDayInput) {
    const now = new Date().toISOString();
    const after = JSON.stringify(content);
    const existing = await this.getDay(day);
    if (existing && JSON.stringify(existing.content) === after) return existing;
    const id = existing?.id ?? dayBlockId(day);

    if (existing) {
      await this.db.execute("UPDATE blocks SET content = $1, updated_at = $2 WHERE id = $3", [after, now, id]);
    } else {
      await this.db.execute(
        `INSERT INTO blocks (id, parent_id, sort_order, type, type_version, day, content, props, created_at, updated_at)
         VALUES ($1, NULL, 0, 'day', 1, $2, $3, '{}', $4, $4)`,
        [id, day, after, now],
      );
    }

    await this.logEvent(id, actor, existing ? "update" : "create", existing ? JSON.stringify(existing.content) : null, after, now);

    // Writing on a day that hasn't come yet turns the page into a reminder.
    let props = existing?.props ?? {};
    if (day > dayKey(new Date()) && !props.reminder) {
      props = await this.setProps(id, actor, props, { ...props, reminder: true }, now);
    }

    await this.setLinks(id, plainText, now);

    return { id, day, content, props, updatedAt: now };
  }

  async listDays() {
    const rows = await this.db.select<{ day: string }[]>(
      "SELECT day FROM blocks WHERE type = 'day' ORDER BY day DESC",
    );
    return rows.map((r) => r.day);
  }

  async wordCounts(from: string, to: string) {
    const rows = await this.db.select<{ day: string; content: string }[]>(
      "SELECT day, content FROM blocks WHERE type = 'day' AND day BETWEEN $1 AND $2",
      [from, to],
    );
    return Object.fromEntries(rows.map((r) => [r.day, countWords(docText(JSON.parse(r.content)))]));
  }

  async openReminders() {
    const rows = await this.db.select<BlockRow[]>(
      `SELECT id, day, content, props, updated_at FROM blocks
       WHERE type = 'day' AND json_extract(props, '$.reminder') = 1
         AND coalesce(json_extract(props, '$.reminderDone'), 0) = 0
       ORDER BY day`,
    );
    // A reminder page whose text was all deleted has nothing left to remind about.
    return rows.map(toPage).filter((p) => docText(p.content).trim());
  }

  private async completeReminderNow(day: string, actor = "me") {
    const page = await this.getDay(day);
    if (!page?.props.reminder || page.props.reminderDone) return;
    await this.setProps(page.id, actor, page.props, { ...page.props, reminderDone: true }, new Date().toISOString());
  }

  async getPage(title: string) {
    const rows = await this.db.select<{ id: string; props: string; content: string; updated_at: string }[]>(
      "SELECT id, props, content, updated_at FROM blocks WHERE type = 'page' AND lower(json_extract(props, '$.title')) = lower($1)",
      [title.trim()],
    );
    const r = rows[0];
    return r ? toNamed(r) : null;
  }

  setPageProps(id: string, patch: Partial<PageProps>, actor = "me") {
    return this.writes.run(async () => {
      const [row] = await this.db.select<{ id: string; props: string; content: string; updated_at: string }[]>(
        "SELECT id, props, content, updated_at FROM blocks WHERE id = $1 AND type = 'page'",
        [id],
      );
      if (!row) throw new Error(`No page ${id}`);
      const { title, ...before } = JSON.parse(row.props) as PageProps & { title: string };
      const after = { title, ...withPatch(before, patch) };
      const now = new Date().toISOString();
      await this.db.execute("UPDATE blocks SET props = $1, updated_at = $2 WHERE id = $3", [JSON.stringify(after), now, id]);
      await this.logEvent(id, actor, "props", row.props, JSON.stringify(after), now);
      return toNamed({ ...row, props: JSON.stringify(after), updated_at: now });
    });
  }

  async projects() {
    const rows = await this.db.select<{ id: string; props: string; content: string; updated_at: string }[]>(
      "SELECT id, props, content, updated_at FROM blocks WHERE type = 'page' AND json_extract(props, '$.project') IS NOT NULL",
    );
    return rows.map(toNamed).sort((a, b) => a.title.localeCompare(b.title));
  }

  private async ensurePageNow(title: string, actor = "me") {
    const existing = await this.getPage(title);
    if (existing) return existing;
    const now = new Date().toISOString();
    const page: NamedPage = { id: pageBlockId(title), title: title.trim(), content: { type: "doc", content: [{ type: "paragraph" }] }, props: {}, updatedAt: now };
    await this.db.execute(
      `INSERT INTO blocks (id, parent_id, sort_order, type, type_version, day, content, props, created_at, updated_at)
       VALUES ($1, NULL, 0, 'page', 1, NULL, $2, $3, $4, $4)`,
      [page.id, JSON.stringify(page.content), JSON.stringify({ title: page.title }), now],
    );
    await this.logEvent(page.id, actor, "create", null, JSON.stringify({ title: page.title, content: page.content }), now);
    return page;
  }

  private async savePageNow({ id, content, plainText, actor = "me" }: { id: string; content: JSONContent; plainText: string; actor?: string }) {
    const rows = await this.db.select<{ props: string; content: string; updated_at: string }[]>(
      "SELECT props, content, updated_at FROM blocks WHERE id = $1 AND type = 'page'",
      [id],
    );
    if (!rows[0]) throw new Error(`No page ${id}`);
    const { title, ...props } = JSON.parse(rows[0].props);
    const after = JSON.stringify(content);
    if (rows[0].content === after) return { id, title, content, props, updatedAt: rows[0].updated_at };
    const now = new Date().toISOString();
    await this.db.execute("UPDATE blocks SET content = $1, updated_at = $2 WHERE id = $3", [after, now, id]);
    await this.logEvent(id, actor, "update", rows[0].content, after, now);
    await this.setLinks(id, plainText, now);
    return { id, title, content, props, updatedAt: now };
  }

  async references(kind: LinkKind, target: string): Promise<Reference[]> {
    const rows = await this.db.select<{ id: string; type: string; day: string | null; props: string; content: string }[]>(
      `SELECT b.id, b.type, b.day, b.props, b.content FROM blocks b
       WHERE b.id IN (SELECT from_block FROM links WHERE kind = $1
         AND (lower(target) = lower($2) OR ($1 = 'tag' AND lower(target) LIKE lower($2) || '/%')))
       ORDER BY b.day DESC`,
      [kind, target.trim()],
    );
    return rows.map((r) => ({
      blockId: r.id,
      day: r.type === "day" ? r.day : null,
      title: r.type === "page" ? JSON.parse(r.props).title : null,
      content: JSON.parse(r.content),
    }));
  }

  async aiChanges(limit = 50) {
    const rows = await this.db.select<(EventRow & { type: string | null; day: string | null; props: string | null; latest_id: string | null })[]>(
      `SELECT e.*, b.type, b.day, b.props,
              (SELECT l.id FROM events l WHERE l.block_id = e.block_id AND l.op IN ('create', 'update')
               ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1) AS latest_id
       FROM events e LEFT JOIN blocks b ON b.id = e.block_id
       WHERE e.actor != 'me' AND e.op IN ('create', 'update')
       ORDER BY e.created_at DESC, e.rowid DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      event: toEvent(r),
      day: r.type === "day" ? r.day : null,
      title: r.type === "page" && r.props ? JSON.parse(r.props).title : null,
      undoable: r.latest_id === r.id,
    }));
  }

  async undoAiChange(eventId: string) {
    const change = (await this.aiChanges(1000)).find((c) => c.event.id === eventId);
    if (!change?.undoable) return false;
    const content = change.event.before ? eventDocument(change.event.before) : { type: "doc", content: [{ type: "paragraph" }] };
    if (change.day) await this.saveDay({ day: change.day, content, plainText: docText(content) });
    else await this.savePage({ id: change.event.blockId, content, plainText: docText(content) });
    return true;
  }

  async graphLinks() {
    const rows = await this.db.select<{ type: string; day: string | null; props: string; target: string; kind: "wikilink" | "tag" }[]>(
      "SELECT b.type, b.day, b.props, l.target, l.kind FROM links l JOIN blocks b ON b.id = l.from_block",
    );
    return rows.map((r) => ({
      day: r.type === "day" ? r.day : null,
      title: r.type === "page" ? JSON.parse(r.props).title : null,
      target: r.target,
      kind: r.kind,
    }));
  }

  async pageNames() {
    const rows = await this.db.select<{ name: string }[]>(
      `SELECT json_extract(props, '$.title') AS name FROM blocks WHERE type = 'page'
       UNION SELECT target AS name FROM links WHERE kind = 'wikilink'`,
    );
    return uniqueNames(rows.map((r) => r.name).filter(Boolean));
  }

  private async saveFileNow(input: SaveFileInput) {
    const record = await newFileRecord(input);
    const same = await this.db.select<FileRow[]>("SELECT * FROM files WHERE hash = $1 LIMIT 1", [record.hash]);
    if (same[0]) return toFile(same[0]);
    const fs = await import("@tauri-apps/plugin-fs");
    const dir = record.path.slice(0, record.path.lastIndexOf("/"));
    await fs.mkdir(dir, { baseDir: fs.BaseDirectory.AppData, recursive: true });
    await fs.writeFile(record.path, input.bytes, { baseDir: fs.BaseDirectory.AppData });
    await this.db.execute(
      "INSERT INTO files (id, path, mime, size, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [record.id, record.path, record.mime, record.size, record.hash, record.createdAt],
    );
    await this.logEvent(record.id, input.actor ?? "me", "create", null, fileEventBody(record), record.createdAt);
    return record;
  }

  async getFile(id: string) {
    const rows = await this.db.select<FileRow[]>("SELECT * FROM files WHERE id = $1", [id]);
    return rows[0] ? toFile(rows[0]) : null;
  }

  async search(query: string) {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    // SQL narrows to blocks whose stored JSON mentions every word; the exact check runs on the text.
    const where = terms.map((_, i) => `lower(content) LIKE '%' || $${i + 1} || '%'`).join(" AND ");
    const rows = await this.db.select<{ id: string; type: string; day: string | null; props: string; content: string }[]>(
      `SELECT id, type, day, props, content FROM blocks WHERE type IN ('day', 'page') AND ${where} ORDER BY day DESC`,
      terms,
    );
    const hits: SearchHit[] = [];
    for (const r of rows.filter((r) => r.type === "day")) {
      const text = docText(JSON.parse(r.content));
      if (matchText(text, terms)) hits.push({ kind: "day", blockId: r.id, day: r.day, title: null, text });
    }
    // Pages also match on their title, which isn't in the content, so check every page.
    for (const r of await this.db.select<{ id: string; props: string; content: string }[]>("SELECT id, props, content FROM blocks WHERE type = 'page'")) {
      const title = JSON.parse(r.props).title as string;
      const text = `${title}\n${docText(JSON.parse(r.content))}`;
      if (matchText(text, terms)) hits.push({ kind: "page", blockId: r.id, day: null, title, text });
    }
    for (const f of await this.listFiles()) {
      if (matchText(f.name, terms)) hits.push({ kind: "file", file: f });
    }
    return hits;
  }

  async listFiles() {
    return (await this.db.select<FileRow[]>("SELECT * FROM files ORDER BY created_at DESC")).map(toFile);
  }

  async findFile(ref: string) {
    const id = idFromRef(ref);
    if (id) return this.getFile(id);
    // Files are stored under their disk-safe name; match that, ignoring letter case.
    const rows = await this.db.select<FileRow[]>(
      "SELECT * FROM files WHERE lower(path) LIKE '%/' || lower($1) ORDER BY created_at DESC LIMIT 1",
      [safeFileName(ref.trim())],
    );
    return rows[0] ? toFile(rows[0]) : null;
  }

  async fileBytes(id: string) {
    const file = await this.getFile(id);
    if (!file) return null;
    const fs = await import("@tauri-apps/plugin-fs");
    return fs.readFile(file.path, { baseDir: fs.BaseDirectory.AppData });
  }

  restore(entries: { name: string; bytes: Uint8Array }[], source: string) {
    return this.writes.run(async () => {
      const db = entries.find((e) => e.name === "journal.db");
      if (!db) throw new Error("This backup comes from the browser preview, not the app.");
      const fs = await import("@tauri-apps/plugin-fs");
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      const base = { baseDir: fs.BaseDirectory.AppData };
      await fs.mkdir("backups", { ...base, recursive: true });
      await fs.writeFile("backups/restore.db", db.bytes, base);
      // Copy the backup's tables over ours. It's one batch so it runs on one pooled connection
      // (ATTACH only applies to the connection that ran it), inside one transaction so a
      // failure leaves the journal as it was.
      const path = (await join(await appDataDir(), "backups/restore.db")).replace(/'/g, "''");
      try {
        await this.db.execute(restoreSql(path));
      } catch (e) {
        await this.db.execute("ROLLBACK; DETACH DATABASE backup;").catch(() => {});
        throw e;
      } finally {
        await fs.remove("backups/restore.db", base).catch(() => {});
      }
      for (const e of entries.filter((e) => e.name.startsWith("attachments/") && !e.name.endsWith("/"))) {
        await fs.mkdir(e.name.slice(0, e.name.lastIndexOf("/")), { ...base, recursive: true });
        await fs.writeFile(e.name, e.bytes, base);
      }
      const [days] = await this.db.select<{ n: number }[]>("SELECT count(*) AS n FROM blocks WHERE type = 'day'");
      const [files] = await this.db.select<{ n: number }[]>("SELECT count(*) AS n FROM files");
      await this.logEvent("journal", "me", "restore", null, JSON.stringify({ source, days: days.n, files: files.n }), new Date().toISOString());
    });
  }

  async syncRecords() {
    const rows = await this.db.select<(EventRow & { type: string | null; day: string | null; props: string | null; file_path: string | null })[]>(
      `SELECT e.*, b.type, b.day, b.props, f.path AS file_path FROM events e
       LEFT JOIN blocks b ON b.id = e.block_id
       LEFT JOIN files f ON f.id = e.block_id
       WHERE e.device_id = $1 AND e.op != 'restore'
       ORDER BY e.created_at, e.rowid`,
      [this.device],
    );
    const files = new Map((await this.listFiles()).map((f) => [f.id, f]));
    const records: SyncRecord[] = [];
    for (const r of rows) {
      const event = toEvent(r);
      let meta: BlockMeta | null = null;
      if (r.type === "day" && r.day) meta = { kind: "block", type: "day", day: r.day };
      else if (r.type === "page" && r.props) meta = { kind: "block", type: "page", title: JSON.parse(r.props).title };
      else if (r.file_path && files.has(r.block_id)) meta = { kind: "file", file: files.get(r.block_id)! };
      if (meta) records.push({ event, meta });
    }
    return records;
  }

  async localBlockId(meta: BlockMeta) {
    if (meta.kind === "file") return meta.file.id;
    if (meta.type === "day") return (await this.getDay(meta.day))?.id ?? null;
    return (await this.getPage(meta.title))?.id ?? null;
  }

  async syncState(blockIds: string[]): Promise<LocalState> {
    const latest: LocalState["latest"] = new Map();
    for (const id of blockIds) latest.set(id, { content: null, props: null });
    if (blockIds.length) {
      const marks = blockIds.map((_, i) => `$${i + 1}`).join(",");
      const rows = await this.db.select<EventRow[]>(`SELECT * FROM events WHERE block_id IN (${marks})`, blockIds);
      for (const r of rows) {
        const e = toEvent(r);
        const which = e.op === "props" ? "props" : e.op === "create" || e.op === "update" ? "content" : null;
        const slot = latest.get(e.blockId);
        if (!which || !slot) continue;
        const key = eventKey(e);
        const cur = slot[which];
        if (!cur || key.join("\u0000") > cur.join("\u0000")) slot[which] = key;
      }
    }
    const docs: LocalState["docs"] = new Map();
    if (blockIds.length) {
      const marks = blockIds.map((_, i) => `$${i + 1}`).join(",");
      const blocks = await this.db.select<{ id: string; content: string }[]>(`SELECT id, content FROM blocks WHERE id IN (${marks})`, blockIds);
      const befores = await this.db.select<{ block_id: string; before: string }[]>(
        `SELECT block_id, before FROM events WHERE before IS NOT NULL AND op IN ('create','update') AND block_id IN (${marks})`,
        blockIds,
      );
      for (const b of blocks) docs.set(b.id, { current: docKey(b.content), befores: new Set() });
      for (const r of befores) docs.get(r.block_id)?.befores.add(docKey(r.before));
    }
    const ids = await this.db.select<{ id: string }[]>("SELECT id FROM events");
    const fileIds = await this.db.select<{ id: string }[]>("SELECT id FROM files");
    return { eventIds: new Set(ids.map((r) => r.id)), latest, fileIds: new Set(fileIds.map((r) => r.id)), docs };
  }

  applySync(plan: MergePlan, blobs: Map<string, Uint8Array>) {
    return this.writes.run(async () => {
      for (const { event: e } of plan.events) {
        await this.db.execute(
          `INSERT OR IGNORE INTO events (id, device_id, actor, block_id, op, before, after, parent_event_ids, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [e.id, e.deviceId, e.actor, e.blockId, e.op, e.before, e.after, JSON.stringify(e.parentEventIds), e.createdAt],
        );
      }
      for (const b of plan.blocks) {
        if (b.meta.kind !== "block") continue;
        const type = b.meta.type;
        const day = b.meta.type === "day" ? b.meta.day : null;
        const startProps = b.meta.type === "page" ? JSON.stringify({ title: b.meta.title }) : "{}";
        await this.db.execute(
          `INSERT OR IGNORE INTO blocks (id, parent_id, sort_order, type, type_version, day, content, props, created_at, updated_at)
           VALUES ($1, NULL, 0, $2, 1, $3, '{"type":"doc","content":[]}', $4, $5, $5)`,
          [b.blockId, type, day, startProps, b.updatedAt],
        );
        const doc = b.content ? eventDocument(b.content) : null;
        if (doc && b.merged) {
          // Both devices wrote here: the kept-both document is a new edit of this device's.
          const [cur] = await this.db.select<{ content: string }[]>("SELECT content FROM blocks WHERE id = $1", [b.blockId]);
          await this.logEvent(b.blockId, "sync", "update", cur?.content ?? null, JSON.stringify(doc), b.updatedAt);
        }
        if (doc) await this.db.execute("UPDATE blocks SET content = $1, updated_at = $2 WHERE id = $3", [JSON.stringify(doc), b.updatedAt, b.blockId]);
        // Day props hold reminder flags; page props hold the title and project info.
        if (b.props) await this.db.execute("UPDATE blocks SET props = $1, updated_at = $2 WHERE id = $3", [b.props, b.updatedAt, b.blockId]);
        if (doc) await this.setLinks(b.blockId, docText(doc), b.updatedAt);
      }
      const fs = await import("@tauri-apps/plugin-fs");
      const base = { baseDir: fs.BaseDirectory.AppData };
      for (const f of plan.files) {
        const bytes = blobs.get(f.hash);
        if (!bytes) continue;
        await fs.mkdir(f.path.slice(0, f.path.lastIndexOf("/")), { ...base, recursive: true });
        await fs.writeFile(f.path, bytes, base);
        await this.db.execute(
          "INSERT OR IGNORE INTO files (id, path, mime, size, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
          [f.id, f.path, f.mime, f.size, f.hash, f.createdAt],
        );
      }
    });
  }

  async exportFiles() {
    const fs = await import("@tauri-apps/plugin-fs");
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    // VACUUM INTO writes a consistent copy of the open database, even mid-edit.
    await fs.mkdir("backups", { baseDir: fs.BaseDirectory.AppData, recursive: true });
    const snapshot = "backups/snapshot.db";
    if (await fs.exists(snapshot, { baseDir: fs.BaseDirectory.AppData })) await fs.remove(snapshot, { baseDir: fs.BaseDirectory.AppData });
    await this.db.execute("VACUUM INTO $1", [await join(await appDataDir(), snapshot)]);
    const entries = [{ name: "journal.db", bytes: await fs.readFile(snapshot, { baseDir: fs.BaseDirectory.AppData }) }];
    await fs.remove(snapshot, { baseDir: fs.BaseDirectory.AppData });
    for (const row of await this.db.select<FileRow[]>("SELECT * FROM files")) {
      entries.push({ name: row.path, bytes: await fs.readFile(row.path, { baseDir: fs.BaseDirectory.AppData }) });
    }
    return entries;
  }

  private async setLinks(id: string, plainText: string, now: string) {
    const { wikilinks, tags } = extractLinks(plainText);
    await this.db.execute("DELETE FROM links WHERE from_block = $1", [id]);
    for (const [kind, targets] of [["wikilink", wikilinks], ["tag", tags]] as const) {
      for (const target of targets) {
        await this.db.execute(
          "INSERT OR IGNORE INTO links (from_block, target, kind, created_at) VALUES ($1, $2, $3, $4)",
          [id, target, kind, now],
        );
      }
    }
  }

  private async setProps(id: string, actor: string, before: DayProps, after: DayProps, now: string) {
    await this.db.execute("UPDATE blocks SET props = $1, updated_at = $2 WHERE id = $3", [JSON.stringify(after), now, id]);
    await this.logEvent(id, actor, "props", JSON.stringify(before), JSON.stringify(after), now);
    return after;
  }

  private async logEvent(blockId: string, actor: string, op: JournalEvent["op"], before: string | null, after: string, now: string) {
    const last = await this.db.select<{ id: string }[]>(
      "SELECT id FROM events WHERE block_id = $1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [blockId],
    );
    await this.db.execute(
      `INSERT INTO events (id, device_id, actor, block_id, op, before, after, parent_event_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newId(), this.device, actor, blockId, op, before, after, JSON.stringify(last.map((e) => e.id)), now],
    );
  }

  async eventsFor(blockId: string) {
    const rows = await this.db.select<EventRow[]>(
      "SELECT * FROM events WHERE block_id = $1 ORDER BY created_at, rowid",
      [blockId],
    );
    return rows.map(toEvent);
  }
}

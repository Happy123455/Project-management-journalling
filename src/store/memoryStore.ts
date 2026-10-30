import { idFromRef } from "../lib/embeds";
import { safeFileName } from "../lib/files";
import { extractLinks, uniqueNames } from "../lib/links";
import { matchText, searchTerms } from "../lib/search";
import { dayKey } from "../lib/timestamp";
import { countWords, docText } from "../lib/words";
import { dayBlockId, deviceId, newId, pageBlockId } from "./ids";
import { Serial } from "./serial";
import { fileEventBody, fromBase64, newFileRecord, toBase64 } from "./files";
import { docKey, eventDocument, eventKey, type BlockMeta, type LocalState, type MergePlan, type SyncRecord } from "../sync/merge";
import { withPatch } from "./props";
import type { DayPage, DayProps, FileRecord, JournalEvent, JournalStore, LinkKind, NamedPage, PageProps, Reference, SaveDayInput, SaveFileInput, SearchHit } from "./types";
import type { JSONContent } from "@tiptap/react";

interface Snapshot {
  pages: Record<string, DayPage>;
  /** Named pages by id. */
  named?: Record<string, NamedPage>;
  /** Attachments by id, with their bytes as base64. */
  files?: Record<string, FileRecord & { data: string }>;
  events: JournalEvent[];
  links: { from: string; target: string; kind: "wikilink" | "tag" }[];
}

const KEY = "dynamic-journal.memory-store";

/** The journal itself, as the block that restore events belong to. */
const RESTORE_BLOCK = "journal";
const restoreBody = (source: string, data: Snapshot) =>
  JSON.stringify({ source, days: Object.keys(data.pages).length, files: Object.keys(data.files ?? {}).length });

const withoutData = ({ data: _data, ...record }: FileRecord & { data: string }): FileRecord => record;

/**
 * Store used in a plain browser (`npm run dev`) and in tests.
 * The real app uses SqliteStore; both follow the same rules.
 */
export class MemoryStore implements JournalStore {
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

  private data: Snapshot;
  readonly deviceId: string;

  constructor(private storage?: Pick<Storage, "getItem" | "setItem">, private device = deviceId(storage)) {
    this.deviceId = device;
    const raw = storage?.getItem(KEY);
    this.data = raw ? JSON.parse(raw) : { pages: {}, events: [], links: [] };
  }

  async getDay(day: string) {
    const page = this.data.pages[day];
    return page ? { ...page, props: page.props ?? {} } : null;
  }

  private async saveDayNow({ day, content, plainText, actor = "me" }: SaveDayInput) {
    const now = new Date().toISOString();
    const existing = await this.getDay(day);
    const after = JSON.stringify(content);
    const page: DayPage = { id: existing?.id ?? dayBlockId(day), day, content, props: existing?.props ?? {}, updatedAt: now };
    if (existing && JSON.stringify(existing.content) === after) return existing;

    this.logEvent(page.id, actor, existing ? "update" : "create", existing ? JSON.stringify(existing.content) : null, after, now);
    // Writing on a day that hasn't come yet turns the page into a reminder.
    if (day > dayKey(new Date()) && !page.props.reminder) {
      const props = { ...page.props, reminder: true };
      this.logEvent(page.id, actor, "props", JSON.stringify(page.props), JSON.stringify(props), now);
      page.props = props;
    }

    this.setLinks(page.id, plainText);
    this.data.pages[day] = page;
    this.storage?.setItem(KEY, JSON.stringify(this.data));
    return page;
  }

  async listDays() {
    return Object.keys(this.data.pages).sort().reverse();
  }

  async wordCounts(from: string, to: string) {
    const counts: Record<string, number> = {};
    for (const page of Object.values(this.data.pages)) {
      if (page.day >= from && page.day <= to) counts[page.day] = countWords(docText(page.content));
    }
    return counts;
  }

  async eventsFor(blockId: string) {
    return this.data.events.filter((e) => e.blockId === blockId);
  }

  async openReminders() {
    return Object.values(this.data.pages)
      .filter((p) => p.props?.reminder && !p.props.reminderDone && docText(p.content).trim())
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  private async completeReminderNow(day: string, actor = "me") {
    const page = await this.getDay(day);
    if (!page?.props.reminder || page.props.reminderDone) return;
    const props: DayProps = { ...page.props, reminderDone: true };
    const now = new Date().toISOString();
    this.logEvent(page.id, actor, "props", JSON.stringify(page.props), JSON.stringify(props), now);
    this.data.pages[day] = { ...page, props, updatedAt: now };
    this.storage?.setItem(KEY, JSON.stringify(this.data));
  }

  async getPage(title: string) {
    const want = title.trim().toLowerCase();
    const page = Object.values(this.named).find((p) => p.title.toLowerCase() === want);
    return page ? { ...page, props: page.props ?? {} } : null;
  }

  setPageProps(id: string, patch: Partial<PageProps>, actor = "me") {
    return this.writes.run(async () => {
      const page = this.named[id];
      if (!page) throw new Error(`No page ${id}`);
      const before = page.props ?? {};
      const props = withPatch(before, patch);
      const now = new Date().toISOString();
      // Events carry the title too, so another device can tell which page it is.
      this.logEvent(id, actor, "props", JSON.stringify({ title: page.title, ...before }), JSON.stringify({ title: page.title, ...props }), now);
      this.named[id] = { ...page, props, updatedAt: now };
      this.persist();
      return this.named[id];
    });
  }

  async projects() {
    return Object.values(this.named)
      .filter((p) => p.props?.project)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  private async ensurePageNow(title: string, actor = "me") {
    const existing = await this.getPage(title);
    if (existing) return existing;
    const now = new Date().toISOString();
    const page: NamedPage = { id: pageBlockId(title), title: title.trim(), content: { type: "doc", content: [{ type: "paragraph" }] }, props: {}, updatedAt: now };
    this.logEvent(page.id, actor, "create", null, JSON.stringify({ title: page.title, content: page.content }), now);
    this.named[page.id] = page;
    this.persist();
    return page;
  }

  private async savePageNow({ id, content, plainText, actor = "me" }: { id: string; content: JSONContent; plainText: string; actor?: string }) {
    const existing = this.named[id];
    if (!existing) throw new Error(`No page ${id}`);
    const after = JSON.stringify(content);
    if (JSON.stringify(existing.content) === after) return existing;
    const now = new Date().toISOString();
    this.logEvent(id, actor, "update", JSON.stringify(existing.content), after, now);
    const page = { ...existing, content, updatedAt: now };
    this.named[id] = page;
    this.setLinks(id, plainText);
    this.persist();
    return page;
  }

  async references(kind: LinkKind, target: string) {
    const want = target.trim().toLowerCase();
    // A tag also finds its branches: #trip finds #trip/goa.
    const matches = (t: string) => t.toLowerCase() === want || (kind === "tag" && t.toLowerCase().startsWith(`${want}/`));
    const from = new Set(this.data.links.filter((l) => l.kind === kind && matches(l.target)).map((l) => l.from));
    const refs: Reference[] = [
      ...Object.values(this.data.pages).filter((p) => from.has(p.id)).map((p) => ({ blockId: p.id, day: p.day, title: null, content: p.content })),
      ...Object.values(this.named).filter((p) => from.has(p.id)).map((p) => ({ blockId: p.id, day: null, title: p.title, content: p.content })),
    ];
    return refs.sort((a, b) => (b.day ?? "").localeCompare(a.day ?? ""));
  }

  async aiChanges(limit = 50) {
    const latest = new Map<string, string>();
    for (const e of this.data.events) if (e.op === "create" || e.op === "update") latest.set(e.blockId, e.id);
    return [...this.data.events]
      .reverse()
      .filter((e) => e.actor !== "me" && (e.op === "create" || e.op === "update"))
      .slice(0, limit)
      .map((event) => {
        const meta = this.metaFor(event.blockId);
        return {
          event,
          day: meta?.kind === "block" && meta.type === "day" ? meta.day : null,
          title: meta?.kind === "block" && meta.type === "page" ? meta.title : null,
          undoable: latest.get(event.blockId) === event.id,
        };
      });
  }

  async undoAiChange(eventId: string) {
    const change = (await this.aiChanges(Infinity)).find((c) => c.event.id === eventId);
    if (!change?.undoable) return false;
    const content = change.event.before ? eventDocument(change.event.before) : { type: "doc", content: [{ type: "paragraph" }] };
    if (change.day) await this.saveDay({ day: change.day, content, plainText: docText(content) });
    else {
      const page = Object.values(this.named).find((p) => p.id === change.event.blockId);
      if (!page) return false;
      await this.savePage({ id: page.id, content, plainText: docText(content) });
    }
    return true;
  }

  async graphLinks() {
    const byId = new Map<string, { day: string | null; title: string | null }>();
    for (const p of Object.values(this.data.pages)) byId.set(p.id, { day: p.day, title: null });
    for (const p of Object.values(this.named)) byId.set(p.id, { day: null, title: p.title });
    return this.data.links.flatMap((l) => {
      const where = byId.get(l.from);
      return where ? [{ ...where, target: l.target, kind: l.kind }] : [];
    });
  }

  async pageNames() {
    const names = [...Object.values(this.named).map((p) => p.title), ...this.data.links.filter((l) => l.kind === "wikilink").map((l) => l.target)];
    return uniqueNames(names);
  }

  private async saveFileNow(input: SaveFileInput) {
    const record = await newFileRecord(input);
    const same = Object.values(this.files).find((f) => f.hash === record.hash);
    if (same) return withoutData(same);
    this.logEvent(record.id, input.actor ?? "me", "create", null, fileEventBody(record), record.createdAt);
    this.files[record.id] = { ...record, data: toBase64(input.bytes) };
    this.persist();
    return record;
  }

  async getFile(id: string) {
    const f = this.files[id];
    return f ? withoutData(f) : null;
  }

  async search(query: string) {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const hits: SearchHit[] = [];
    const days = Object.values(this.data.pages).sort((a, b) => b.day.localeCompare(a.day));
    for (const p of days) {
      const text = docText(p.content);
      if (matchText(text, terms)) hits.push({ kind: "day", blockId: p.id, day: p.day, title: null, text });
    }
    for (const p of Object.values(this.named)) {
      const text = `${p.title}\n${docText(p.content)}`;
      if (matchText(text, terms)) hits.push({ kind: "page", blockId: p.id, day: null, title: p.title, text });
    }
    for (const f of await this.listFiles()) {
      if (matchText(f.name, terms)) hits.push({ kind: "file", file: f });
    }
    return hits;
  }

  async listFiles() {
    return Object.values(this.files)
      .map(withoutData)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findFile(ref: string) {
    const id = idFromRef(ref);
    if (id) return this.getFile(id);
    const want = safeFileName(ref.trim()).toLowerCase();
    const match = Object.values(this.files)
      .filter((f) => f.name.toLowerCase() === want)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return match ? withoutData(match) : null;
  }

  async fileBytes(id: string) {
    const f = this.files[id];
    return f ? fromBase64(f.data) : null;
  }

  restore(entries: { name: string; bytes: Uint8Array }[], source: string) {
    return this.writes.run(async () => {
      const json = entries.find((e) => e.name === "journal.json");
      if (!json) throw new Error("This backup comes from the app; restore it there.");
      const data = JSON.parse(new TextDecoder().decode(json.bytes)) as Snapshot;
      const bytes = new Map(entries.map((e) => [e.name, e.bytes]));
      const files: NonNullable<Snapshot["files"]> = {};
      for (const f of Object.values(data.files ?? {})) {
        const b = bytes.get(f.path);
        if (b) files[f.id] = { ...f, data: toBase64(b) };
      }
      this.data = { ...data, files };
      this.logEvent(RESTORE_BLOCK, "me", "restore", null, restoreBody(source, data), new Date().toISOString());
      this.persist();
    });
  }

  async syncRecords() {
    const records: SyncRecord[] = [];
    for (const event of this.data.events) {
      if (event.deviceId !== this.device || event.op === "restore") continue;
      const meta = this.metaFor(event.blockId);
      if (meta) records.push({ event, meta });
    }
    return records;
  }

  async localBlockId(meta: BlockMeta) {
    if (meta.kind === "file") return meta.file.id;
    if (meta.type === "day") return this.data.pages[meta.day]?.id ?? null;
    return (await this.getPage(meta.title))?.id ?? null;
  }

  async syncState(blockIds: string[]): Promise<LocalState> {
    const latest: LocalState["latest"] = new Map();
    for (const id of blockIds) latest.set(id, { content: null, props: null });
    for (const e of this.data.events) {
      const slot = latest.get(e.blockId);
      if (!slot) continue;
      const which = e.op === "props" ? "props" : e.op === "create" || e.op === "update" ? "content" : null;
      if (!which) continue;
      const key = eventKey(e);
      const cur = slot[which];
      if (!cur || key.join("\u0000") > cur.join("\u0000")) slot[which] = key;
    }
    const docs: LocalState["docs"] = new Map();
    for (const id of blockIds) {
      const page = Object.values(this.data.pages).find((p) => p.id === id) ?? this.named[id];
      if (page) docs.set(id, { current: JSON.stringify(page.content), befores: new Set() });
    }
    for (const e of this.data.events) {
      if (e.before && (e.op === "create" || e.op === "update")) docs.get(e.blockId)?.befores.add(docKey(e.before));
    }
    return { eventIds: new Set(this.data.events.map((e) => e.id)), latest, fileIds: new Set(Object.keys(this.files)), docs };
  }

  applySync(plan: MergePlan, blobs: Map<string, Uint8Array>) {
    return this.writes.run(async () => {
      const known = new Set(this.data.events.map((e) => e.id));
      for (const r of plan.events) if (!known.has(r.event.id)) this.data.events.push(r.event);
      for (const b of plan.blocks) {
        if (b.meta.kind !== "block") continue;
        const content = b.content ? eventDocument(b.content) : undefined;
        const props = b.props ? JSON.parse(b.props) : undefined;
        if (content && b.merged) {
          // Both devices wrote here: the kept-both document is a new edit of this device's.
          const cur = b.meta.type === "day" ? this.data.pages[b.meta.day] : this.named[b.blockId];
          this.logEvent(b.blockId, "sync", "update", cur ? JSON.stringify(cur.content) : null, JSON.stringify(content), b.updatedAt);
        }
        if (b.meta.type === "day") {
          const cur = this.data.pages[b.meta.day];
          const page: DayPage = cur ?? { id: b.blockId, day: b.meta.day, content: { type: "doc", content: [] }, props: {}, updatedAt: b.updatedAt };
          this.data.pages[b.meta.day] = { ...page, content: content ?? page.content, props: props ?? page.props ?? {}, updatedAt: b.updatedAt };
          this.setLinks(page.id, docText(this.data.pages[b.meta.day].content));
        } else {
          const cur = this.named[b.blockId];
          const page: NamedPage = cur ?? { id: b.blockId, title: b.meta.title, content: { type: "doc", content: [] }, props: {}, updatedAt: b.updatedAt };
          const { title: _title, ...pageProps } = (props ?? page.props ?? {}) as PageProps & { title?: string };
          this.named[b.blockId] = { ...page, content: content ?? page.content, props: pageProps, updatedAt: b.updatedAt };
          this.setLinks(b.blockId, docText(this.named[b.blockId].content));
        }
      }
      for (const f of plan.files) {
        const bytes = blobs.get(f.hash);
        if (bytes && !this.files[f.id]) this.files[f.id] = { ...f, data: toBase64(bytes) };
      }
      this.persist();
    });
  }

  /** What a block is, for sync: a day page, a named page or a file. */
  private metaFor(blockId: string): BlockMeta | null {
    const day = Object.values(this.data.pages).find((p) => p.id === blockId);
    if (day) return { kind: "block", type: "day", day: day.day };
    const page = this.named[blockId];
    if (page) return { kind: "block", type: "page", title: page.title };
    const file = this.files[blockId];
    return file ? { kind: "file", file: withoutData(file) } : null;
  }

  async exportFiles() {
    const { files, ...rest } = this.data;
    const journal = { ...rest, files: Object.fromEntries(Object.entries(files ?? {}).map(([id, f]) => [id, withoutData(f)])) };
    return [
      { name: "journal.json", bytes: new TextEncoder().encode(JSON.stringify(journal)) },
      ...Object.values(files ?? {}).map((f) => ({ name: f.path, bytes: fromBase64(f.data) })),
    ];
  }

  private get files() {
    return (this.data.files ??= {});
  }

  private get named() {
    return (this.data.named ??= {});
  }

  private setLinks(blockId: string, plainText: string) {
    const { wikilinks, tags } = extractLinks(plainText);
    this.data.links = this.data.links.filter((l) => l.from !== blockId);
    wikilinks.forEach((target) => this.data.links.push({ from: blockId, target, kind: "wikilink" }));
    tags.forEach((target) => this.data.links.push({ from: blockId, target, kind: "tag" }));
  }

  private persist() {
    this.storage?.setItem(KEY, JSON.stringify(this.data));
  }

  private logEvent(blockId: string, actor: string, op: JournalEvent["op"], before: string | null, after: string, now: string) {
    const last = [...this.data.events].reverse().find((e) => e.blockId === blockId);
    this.data.events.push({
      id: newId(),
      deviceId: this.device,
      actor,
      blockId,
      op,
      before,
      after,
      parentEventIds: last ? [last.id] : [],
      createdAt: now,
    });
  }
}

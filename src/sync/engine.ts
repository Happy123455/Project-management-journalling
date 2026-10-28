import type { JournalStore } from "../store/types";
import { fromLines, monthOf, planMerge, toLines, type SyncRecord } from "./merge";

/** The shared folder (Google Drive), seen as paths relative to "Dynamic Journal Sync/". */
export interface SyncFolder {
  /** Names directly inside a folder, or [] when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array | null>;
  /** Creates parent folders as needed and replaces the file. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface SyncResult {
  exported: number;
  imported: number;
  files: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * One sync round:
 * 1. write this device's new events to events/<device>/<yyyy-mm>.jsonl (only ever its own files)
 *    and its attachments to files/<hash>;
 * 2. read every other device's files, and import the events this device doesn't have yet.
 */
export async function syncOnce(store: JournalStore, folder: SyncFolder): Promise<SyncResult> {
  const me = store.deviceId;

  // 1. Export.
  const own = await store.syncRecords();
  let exported = 0;
  const byMonth = new Map<string, SyncRecord[]>();
  for (const r of own) byMonth.set(monthOf(r.event.createdAt), [...(byMonth.get(monthOf(r.event.createdAt)) ?? []), r]);
  for (const [month, records] of byMonth) {
    const path = `events/${me}/${month}.jsonl`;
    const existing = fromLines(dec.decode((await folder.read(path)) ?? new Uint8Array()));
    const have = new Set(existing.map((r) => r.event.id));
    const missing = records.filter((r) => !have.has(r.event.id));
    if (!missing.length) continue;
    await folder.write(path, enc.encode(toLines([...existing, ...missing])));
    exported += missing.length;
  }
  for (const r of own) {
    if (r.meta.kind !== "file") continue;
    const path = `files/${r.meta.file.hash}`;
    if (await folder.exists(path)) continue;
    const bytes = await store.fileBytes(r.meta.file.id);
    if (bytes) await folder.write(path, bytes);
  }

  // 2. Import from every other device.
  const incoming: SyncRecord[] = [];
  for (const device of await folder.list("events")) {
    if (device === me) continue;
    for (const file of await folder.list(`events/${device}`)) {
      if (!file.endsWith(".jsonl")) continue;
      incoming.push(...fromLines(dec.decode((await folder.read(`events/${device}/${file}`)) ?? new Uint8Array())));
    }
  }
  // Pages both devices made for the same day (or name) before syncing are one page here.
  for (const r of incoming) {
    if (r.meta.kind !== "block") continue;
    const local = await store.localBlockId(r.meta);
    if (local && local !== r.event.blockId) r.event = { ...r.event, blockId: local };
  }
  const state = await store.syncState([...new Set(incoming.map((r) => r.event.blockId))]);
  const plan = planMerge(state, incoming);
  const blobs = new Map<string, Uint8Array>();
  for (const f of plan.files) {
    const bytes = await folder.read(`files/${f.hash}`);
    if (bytes) blobs.set(f.hash, bytes);
  }
  if (plan.events.length || plan.files.length) await store.applySync(plan, blobs);
  return { exported, imported: plan.events.length, files: blobs.size };
}

/** A folder in memory, for tests and the browser preview. */
export class MemoryFolder implements SyncFolder {
  files = new Map<string, Uint8Array>();
  async list(dir: string) {
    const prefix = dir ? `${dir}/` : "";
    const names = new Set<string>();
    for (const path of this.files.keys()) if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0]);
    return [...names];
  }
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
}

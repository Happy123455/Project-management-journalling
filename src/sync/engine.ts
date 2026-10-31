import type { JournalStore } from "../store/types";
import { fromLines, planMerge, toLines, type SyncRecord } from "./merge";

/** The shared folder (Google Drive), seen as paths relative to "Dynamic Journal Sync/". */
export interface SyncFolder {
  /** Names directly inside a folder, or [] when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array | null>;
  /** Creates parent folders as needed and replaces the file. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Something that changes whenever the file does (size and time), when cheap to know. */
  stamp?(path: string): Promise<string | null>;
  /** Bytes used by the sync folder, and the Google account's storage (limit/usage) when known. */
  usage?(): Promise<StorageUsage>;
}

export interface StorageUsage {
  folderBytes: number;
  files: number;
  /** The whole Google account (Drive + Gmail + Photos). limit is null for unlimited plans. */
  account?: { limit: number | null; usage: number; drive: number };
}

/** What this device remembers between rounds, so it doesn't download what it already has. */
export interface SyncMemory {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Remembers nothing between calls (tests); the app keeps it in localStorage. */
export const memoryOnly = (): SyncMemory => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

/** Sent: this device's files in the folder, the events in them, the attachments uploaded. Seen: other devices' files imported. */
interface Remembered {
  files: string[];
  ids: string[];
  hashes: string[];
  seen: string[];
}

/** Month files from before sync wrote new events into new files; older app versions still add to them. */
const LEGACY = /^\d{4}-\d{2}\.jsonl$/;

export interface SyncResult {
  exported: number;
  imported: number;
  files: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * One sync round:
 * 1. write this device's new events to a new events/<device>/<time>.jsonl (only ever its own files)
 *    and its attachments to files/<hash>;
 * 2. read the other devices' files it hasn't read yet, and import the events this device doesn't have.
 * Files are never rewritten, so on the phone a round only downloads what's new (mobile data).
 */
export async function syncOnce(store: JournalStore, folder: SyncFolder, memory: SyncMemory = memoryOnly()): Promise<SyncResult> {
  const me = store.deviceId;
  const saved = memory.get("journal.sync");
  let mem: Remembered = saved ? JSON.parse(saved) : { files: [], ids: [], hashes: [], seen: [] };
  const remember = () => memory.set("journal.sync", JSON.stringify(mem));

  // 1. Export.
  const own = await store.syncRecords();
  const ownFiles = (await folder.list(`events/${me}`)).filter((f) => f.endsWith(".jsonl"));
  if (!saved || ownFiles.length !== mem.files.length || ownFiles.some((f) => !mem.files.includes(f))) {
    // First round here, or a different folder (another Drive account): see what's already there.
    const ids = new Set<string>();
    for (const f of ownFiles) for (const r of fromLines(dec.decode((await folder.read(`events/${me}/${f}`)) ?? new Uint8Array()))) ids.add(r.event.id);
    mem = { files: ownFiles, ids: [...ids], hashes: [], seen: saved ? mem.seen : [] };
  }
  const sent = new Set(mem.ids);
  const missing = own.filter((r) => !sent.has(r.event.id));
  if (missing.length) {
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
    await folder.write(`events/${me}/${name}`, enc.encode(toLines(missing)));
    mem.files.push(name);
    mem.ids.push(...missing.map((r) => r.event.id));
  }
  remember();
  const uploaded = new Set(mem.hashes);
  for (const r of own) {
    if (r.meta.kind !== "file" || uploaded.has(r.meta.file.hash)) continue;
    const path = `files/${r.meta.file.hash}`;
    if (!(await folder.exists(path))) {
      const bytes = await store.fileBytes(r.meta.file.id);
      if (!bytes) continue;
      await folder.write(path, bytes);
    }
    uploaded.add(r.meta.file.hash);
    mem.hashes.push(r.meta.file.hash);
    remember();
  }

  // 2. Import from every other device.
  const incoming: SyncRecord[] = [];
  const seen = new Set(mem.seen);
  const read: string[] = [];
  for (const device of await folder.list("events")) {
    if (device === me) continue;
    for (const file of await folder.list(`events/${device}`)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = `events/${device}/${file}`;
      const stamp = (await folder.stamp?.(path)) ?? (LEGACY.test(file) ? null : "");
      const key = stamp === null ? null : `${path}@${stamp}`;
      if (key && seen.has(key)) continue;
      incoming.push(...fromLines(dec.decode((await folder.read(path)) ?? new Uint8Array())));
      if (key) read.push(key);
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
  // A legacy month file is read again when it changes; drop its older stamps.
  const replaced = new Set(read.map((k) => k.slice(0, k.lastIndexOf("@"))));
  mem.seen = [...mem.seen.filter((k) => !replaced.has(k.slice(0, k.lastIndexOf("@")))), ...read];
  remember();
  return { exported: missing.length, imported: plan.events.length, files: blobs.size };
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

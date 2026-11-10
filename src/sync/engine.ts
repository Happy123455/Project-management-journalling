import type { FileRecord, JournalStore } from "../store/types";
import { sha256 } from "../lib/files";
import { eventDocument, fromLines, idsIn, planMerge, refsIn, sideNames, takeMergeNotes, toLines, type MergePlan, type SyncRecord } from "./merge";
import { anomalies, logAnomaly, short, stamp, type Path } from "./anomalies";
import { hash, siblingIds } from "./lineIds";
import { onMobileData } from "./network";
import { showToast } from "../lib/toast";
import type { JSONContent } from "@tiptap/react";
import { logTransfer } from "./transferLog";

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
  /** Per note: the last content event sent and a hash of the note it left, so the next file can point at it. */
  last?: Record<string, [id: string, afterHash: string][]>;
  /** Newest sync log entry already copied to logs/<device>.json. */
  logAt?: number;
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

const PART_BYTES = 4 * 1024 * 1024;
/** On mobile data, attachments bigger than this wait for Wi-Fi (up and down). */
const SMALL_FILE = 300 * 1024;
const BIG_DOWNLOAD = 1024 * 1024;

/** Records split into runs whose lines add up to at most `max` bytes (a bigger single record goes alone). */
export function inParts(records: SyncRecord[], max: number): SyncRecord[][] {
  const parts: SyncRecord[][] = [];
  let cur: SyncRecord[] = [];
  let size = 0;
  for (const r of records) {
    const n = enc.encode(toLines([r])).length + 1;
    if (cur.length && size + n > max) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/**
 * One sync round:
 * 1. write this device's new events to a new events/<device>/<time>.jsonl (only ever its own files)
 *    and its attachments to files/<hash>;
 * 2. read the other devices' files it hasn't read yet, and import the events this device doesn't have.
 * Files are never rewritten, so on the phone a round only downloads what's new (mobile data).
 */
export async function syncOnce(store: JournalStore, plainFolder: SyncFolder, memory: SyncMemory = memoryOnly()): Promise<SyncResult> {
  const me = store.deviceId;
  // Bytes in and out this round, for the network history.
  const moved = { up: 0, down: 0, photosUp: 0 };
  const folder: SyncFolder = Object.assign(Object.create(plainFolder), {
    read: async (path: string) => {
      const b = await plainFolder.read(path);
      if (b) moved.down += b.length;
      return b;
    },
    write: async (path: string, b: Uint8Array) => {
      await plainFolder.write(path, b);
      moved.up += b.length;
      if (path.startsWith("files/")) moved.photosUp++;
    },
  });
  const saved = memory.get("journal.sync");
  let mem: Remembered = saved ? JSON.parse(saved) : { files: [], ids: [], hashes: [], seen: [] };
  // Written only when something changed: it holds every id ever sent (hundreds of KB by now), and
  // most rounds (a poll with nothing new) change nothing.
  let written = saved;
  const remember = () => {
    const next = JSON.stringify(mem);
    if (next !== written) memory.set("journal.sync", (written = next));
  };

  // 1. Export.
  const ownFiles = (await folder.list(`events/${me}`)).filter((f) => f.endsWith(".jsonl"));
  const sameFolder = !saved || !mem.files.length || ownFiles.some((f) => mem.files.includes(f));
  if (!saved || !sameFolder) {
    // First round here, or a different folder (another Drive account): see what's already there.
    const ids = new Set<string>();
    for (const f of ownFiles) for (const id of idsIn(dec.decode((await folder.read(`events/${me}/${f}`)) ?? new Uint8Array()))) ids.add(id);
    mem = { files: ownFiles, ids: [...ids], hashes: [], seen: saved ? mem.seen : [] };
  } else {
    // Batch 17: a listing that differs from memory (Drive's list lagging behind a file just written,
    // or one more page of files) used to throw memory away and download ALL of this device's files
    // again (~270 MB, 562 files) before uploading anything; on mobile data that never finished, so
    // the phone's edits stopped reaching the Mac. Now only own files it doesn't know are read, and
    // the ones it remembers stay remembered even when a listing misses them.
    const known = new Set(mem.files);
    const fresh = ownFiles.filter((f) => !known.has(f));
    if (fresh.length) {
      const ids = new Set(mem.ids);
      for (const f of fresh) for (const id of idsIn(dec.decode((await folder.read(`events/${me}/${f}`)) ?? new Uint8Array()))) ids.add(id);
      mem = { ...mem, files: [...mem.files, ...fresh], ids: [...ids] };
    }
  }
  // Attachments first, so another device never reads an event whose bytes aren't there yet.
  // On mobile data only small ones go; photos and videos wait for Wi-Fi (their notes still go now).
  const cellular = onMobileData();
  let held = 0;
  const uploaded = new Set(mem.hashes);
  for (const f of await store.listFiles()) {
    if (uploaded.has(f.hash)) continue;
    if (cellular && f.size > SMALL_FILE) {
      held++;
      continue;
    }
    const path = `files/${f.hash}`;
    if (!(await folder.exists(path))) {
      const bytes = await store.fileBytes(f.id).catch(() => null);
      if (!bytes) continue;
      await folder.write(path, bytes);
    }
    uploaded.add(f.hash);
    mem.hashes.push(f.hash);
    remember();
  }

  // Only the events not sent yet are read in full (each one can hold a whole page).
  const sent = new Set(mem.ids);
  // Held files: their create events wait too, so the other device never looks for bytes not there yet.
  const heldIds = new Set(cellular && held ? (await store.listFiles()).filter((f) => !uploaded.has(f.hash)).map((f) => f.id) : []);
  const missing = (await store.syncRecords(sent)).filter((r) => !(r.meta.kind === "file" && heldIds.has(r.meta.file.id)));
  const lastOut = (mem.last ??= {});
  for (const [blockId, id, h] of arrived.splice(0)) knownNote(lastOut, blockId, id, h);
  const ref = (blockId: string, before: string) => {
    const h = hash(before);
    return lastOut[blockId]?.find((l) => l[1] === h)?.[0] ?? null;
  };
  // Batch 17: in parts of ~4 MB, each remembered once it's on Drive. One file holding a backlog of
  // whole-page edits grew past what one Drive upload takes; it failed at the end and was sent again
  // every round (mobile data used, nothing ever arrived on the Mac).
  for (const part of inParts(missing, PART_BYTES)) {
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
    await folder.write(`events/${me}/${name}`, enc.encode(toLines(part, ref)));
    for (const r of part) if ((r.event.op === "update" || r.event.op === "create") && r.event.after && r.meta.kind === "block") knownNote(lastOut, r.event.blockId, r.event.id, hash(r.event.after));
    mem.files.push(name);
    mem.ids.push(...part.map((r) => r.event.id));
    remember();
  }
  remember();
  // 2. Import from every other device.
  const incoming: SyncRecord[] = [];
  const seen = new Set(mem.seen);
  const read: string[] = [];
  // Notes earlier files in this round left, for files that point at them instead of repeating them.
  const roundAfters = new Map<string, string>();
  for (const device of await folder.list("events")) {
    if (device === me) continue;
    // Oldest first (names start with the time), so a file's base is read before it.
    for (const file of (await folder.list(`events/${device}`)).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      const path = `events/${device}/${file}`;
      const stamp = (await folder.stamp?.(path)) ?? (LEGACY.test(file) ? null : "");
      const key = stamp === null ? null : `${path}@${stamp}`;
      if (key && seen.has(key)) continue;
      const text = dec.decode((await folder.read(path)) ?? new Uint8Array());
      const bases = new Map<string, string>();
      for (const id of refsIn(text)) {
        const b = roundAfters.get(id) ?? (await store.eventAfter?.(id).catch(() => null));
        if (b) bases.set(id, b);
      }
      const lost: string[] = [];
      const got = fromLines(text, bases, lost);
      for (const r of got) if (r.event.after) roundAfters.set(r.event.id, r.event.after);
      incoming.push(...got);
      if (lost.length) {
        // Its base hasn't arrived here yet: read the file again next round.
        logAnomaly({ kind: "unreadable", path: "cloud", text: `${lost.length} edit(s) in ${file} wait for an earlier edit not here yet`, detail: { file: path, events: lost.slice(0, 10), refs: refsIn(text).slice(0, 10) } });
        continue;
      }
      if (key) read.push(key);
    }
  }
  const plan = await importRecords(store, incoming);
  // Bytes travel separately from the events and can reach the folder later (the phone uploads
  // after writing its events; Drive for desktop downloads in its own time). Every file whose
  // bytes this device still lacks is tried again each round until they arrive.
  const want = new Map<string, FileRecord>();
  for (const f of [...plan.files, ...(await store.missingFiles())]) want.set(f.id, f);
  const blobs = new Map<string, Uint8Array>();
  const got: FileRecord[] = [];
  for (const f of want.values()) {
    // Big photos and videos come down on Wi-Fi.
    if (cellular && f.size > BIG_DOWNLOAD) {
      held++;
      continue;
    }
    if (!blobs.has(f.hash)) {
      const bytes = await folder.read(`files/${f.hash}`).catch(() => null);
      // Only whole files: a copy still being written (or cut short) is fetched again next round.
      if (!bytes || (await sha256(bytes)) !== f.hash) continue;
      blobs.set(f.hash, bytes);
    }
    got.push(f);
  }
  if (got.length) await store.applySync({ events: [], blocks: [], files: got }, blobs);
  // A legacy month file is read again when it changes; drop its older stamps.
  const replaced = new Set(read.map((k) => k.slice(0, k.lastIndexOf("@"))));
  mem.seen = [...mem.seen.filter((k) => !replaced.has(k.slice(0, k.lastIndexOf("@")))), ...read];
  remember();
  // The sync log goes to the folder too (on Wi-Fi only), so both devices' logs can be read side by side.
  const log = typeof window !== "undefined" ? anomalies() : [];
  if (!cellular && log.length && log[0].at !== mem.logAt) {
    await folder.write(`logs/${me}.json`, enc.encode(JSON.stringify({ device: me, at: new Date().toISOString(), entries: log }))).then(
      () => ((mem.logAt = log[0].at), remember()),
      () => {},
    );
  }
  const what = [
    missing.length && `${missing.length} edit${missing.length === 1 ? "" : "s"} sent`,
    plan.events.length && `${plan.events.length} received`,
    moved.photosUp && `${moved.photosUp} file${moved.photosUp === 1 ? "" : "s"} up`,
    got.length && `${got.length} file${got.length === 1 ? "" : "s"} down`,
    held && `${held} big file${held === 1 ? "" : "s"} wait for Wi-Fi`,
  ].filter(Boolean).join(", ");
  if (typeof window !== "undefined") logTransfer({ via: cellular ? "mobile" : "drive", up: moved.up, down: moved.down, what: what || "checked, nothing new" });
  return { exported: missing.length, imported: plan.events.length, files: got.length };
}

/**
 * Adds other devices' events to this one through the merge (Drive rounds and the direct Wi-Fi
 * link both come here). Events already known are skipped, so the same edit arriving both ways
 * changes nothing the second time. File bytes are not fetched here.
 */
/** Notes both devices have as an event: [block, event id, hash of its after] (see toLines `ref`). */
const arrived: [string, string, string][] = [];
function knownNote(last: Record<string, [string, string][]>, blockId: string, id: string, h: string) {
  const list = (last[blockId] ?? []).filter((l) => l[0] !== id);
  list.unshift([id, h]);
  last[blockId] = list.slice(0, 4);
}

/** One import at a time, so a Wi-Fi batch and a Drive round never merge the same page at once. */
let importing: Promise<unknown> = Promise.resolve();
export function importRecords(store: JournalStore, incoming: SyncRecord[], via: Path = "cloud"): Promise<MergePlan> {
  const next = importing.then(() => importNow(store, incoming, via));
  importing = next.catch(() => {});
  return next;
}

async function importNow(store: JournalStore, incoming: SyncRecord[], via: Path) {
  const started = Date.now();
  // Pages both devices made for the same day (or name) before syncing are one page here.
  for (const r of incoming) {
    if (r.meta.kind !== "block") continue;
    const local = await store.localBlockId(r.meta);
    if (local && local !== r.event.blockId) r.event = { ...r.event, blockId: local };
  }
  const state = await store.syncState([...new Set(incoming.map((r) => r.event.blockId))]);
  takeMergeNotes();
  const plan = planMerge(state, incoming);
  try {
    noteImport(state, plan, via, started, takeMergeNotes());
  } catch {
    // The log never stops a sync.
  }
  if (plan.events.length) await store.applySync({ ...plan, files: [] }, new Map());
  // A note taken as the other device left it: this device's next edit can point at that event.
  for (const b of plan.blocks) {
    if (b.merged || !b.content) continue;
    const e = plan.events.find((r) => r.event.blockId === b.blockId && r.event.after === b.content)?.event;
    if (e) arrived.push([b.blockId, e.id, hash(b.content)]);
  }
  if (arrived.length > 200) arrived.splice(0, arrived.length - 200);
  return plan;
}

const plain = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(plain).join("");
const noteName = (r: SyncRecord) => (r.meta.kind === "block" ? (r.meta.type === "day" ? `day:${r.meta.day}` : `page:${r.meta.title}`) : undefined);

/** Writes what this import found that wasn't plain sailing to the anomaly log. */
function noteImport(state: Awaited<ReturnType<JournalStore["syncState"]>>, plan: MergePlan, via: Path, started: number, notes: ReturnType<typeof takeMergeNotes>) {
  const now = Date.now();
  for (const r of plan.events) {
    const e = r.event;
    const at = Date.parse(e.createdAt);
    if (at - now > 2000) logAnomaly({ kind: "clock-ahead", path: via, note: noteName(r), text: `${e.deviceId} clock is ${at - now} ms ahead of this one`, detail: { event: e.id, createdAt: e.createdAt, here: stamp(now) } });
    const mine = state.latest.get(e.blockId)?.content;
    if ((e.op === "update" || e.op === "create") && mine && mine[0] > e.createdAt && mine[1] !== e.deviceId) {
      logAnomaly({
        kind: "out-of-order",
        path: via,
        note: noteName(r),
        text: `edit from ${stamp(e.createdAt)} arrived after this device's newer one (${stamp(mine[0])})`,
        detail: { event: e.id, device: e.deviceId, theirAt: e.createdAt, mineAt: mine[0], gapMs: Date.parse(mine[0]) - at, lagMs: now - at },
      });
    }
  }
  for (const b of plan.blocks) {
    const r = plan.events.filter((x) => x.event.blockId === b.blockId).pop();
    const name = r ? noteName(r) : b.blockId;
    const theirAt = r?.event.createdAt;
    const mineAt = state.latest.get(b.blockId)?.content?.[0];
    const timing = {
      theirAt,
      mineAt,
      arrivedAt: new Date(now).toISOString(),
      lagMs: theirAt ? now - Date.parse(theirAt) : undefined,
      apartMs: theirAt && mineAt ? Math.abs(Date.parse(theirAt) - Date.parse(mineAt)) : undefined,
      mergeMs: now - started,
      device: r?.event.deviceId,
    };
    // Lines the other device's version takes out of this note.
    const cur = state.docs?.get(b.blockId)?.current;
    if (b.content && cur) {
      try {
        const before = (JSON.parse(cur) as JSONContent).content ?? [];
        const after = eventDocument(b.content).content ?? [];
        const kept = new Set(siblingIds(after));
        const ids = siblingIds(before);
        const gone = before.filter((n, i) => !kept.has(ids[i]) && plain(n).trim()).map((n) => short(plain(n)));
        if (gone.length && typeof window !== "undefined")
          showToast(`${sideNames().other} removed ${gone.length === 1 ? `"${short(gone[0], 40)}"` : `${gone.length} lines`} from ${name?.replace(/^(day|page):/, "")}. To put it back: Nexus → This note`);
        if (gone.length) logAnomaly({ kind: "lines-removed", path: via, note: name, text: `${gone.length} line${gone.length === 1 ? "" : "s"} removed by ${r?.event.deviceId ?? "sync"}: ${gone.join(" · ")}`, detail: { ...timing, lines: gone } });
      } catch {
        // Unreadable: nothing to compare.
      }
    }
    if (b.merged) for (const n of notes) logAnomaly({ kind: n.kind, path: via, note: name, text: Object.entries(n.texts).map(([k, v]) => `${k}: "${short(v, 60)}"`).join(" / "), detail: { ...timing, line: n.line, texts: n.texts } });
  }
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

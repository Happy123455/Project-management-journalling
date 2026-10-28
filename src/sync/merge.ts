import type { FileRecord, JournalEvent } from "../store/types";

/**
 * What a block is, so another device can create it from events alone. Day pages are found by
 * day, named pages by title; files carry their record (the bytes travel separately, by hash).
 */
export type BlockMeta =
  | { kind: "block"; type: "day"; day: string }
  | { kind: "block"; type: "page"; title: string }
  | { kind: "file"; file: FileRecord };

/** One line of a device's sync file: an event and the block it belongs to. */
export interface SyncRecord {
  event: JournalEvent;
  meta: BlockMeta;
}

/** Orders events across devices: time, then device id, then event id, so every device agrees. */
export type EventKey = [createdAt: string, deviceId: string, id: string];
export const eventKey = (e: JournalEvent): EventKey => [e.createdAt, e.deviceId, e.id];
export function compareKeys(a: EventKey, b: EventKey): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** What this device already has, as far as merging needs to know. */
export interface LocalState {
  eventIds: Set<string>;
  /** For each block: the newest content event and newest props event applied here. */
  latest: Map<string, { content: EventKey | null; props: EventKey | null }>;
  fileIds: Set<string>;
}

/** What to change locally. Applying it twice changes nothing more (imports are idempotent). */
export interface MergePlan {
  /** Events to add to the local log, oldest first. */
  events: SyncRecord[];
  /** Blocks whose content and/or props should be replaced by a newer remote version. */
  blocks: { blockId: string; meta: BlockMeta; content?: string; props?: string; updatedAt: string }[];
  /** Files this device doesn't have yet; their bytes come from files/<hash>. */
  files: FileRecord[];
}

const isContent = (e: JournalEvent) => e.op === "create" || e.op === "update";

/**
 * Last writer wins per block, separately for content and for props, by (time, device, id).
 * Older remote edits still join the log, keeping their parent ids for the conflict view.
 */
export function planMerge(local: LocalState, incoming: SyncRecord[]): MergePlan {
  const seen = new Set(local.eventIds);
  const fresh: SyncRecord[] = [];
  for (const r of incoming) {
    if (seen.has(r.event.id) || r.event.op === "restore") continue;
    seen.add(r.event.id);
    fresh.push(r);
  }
  fresh.sort((a, b) => compareKeys(eventKey(a.event), eventKey(b.event)));

  const files: FileRecord[] = [];
  const winners = new Map<string, { meta: BlockMeta; content?: SyncRecord; props?: SyncRecord }>();
  for (const r of fresh) {
    const meta = r.meta;
    if (meta.kind === "file") {
      if (!local.fileIds.has(meta.file.id) && !files.some((f) => f.id === meta.file.id)) files.push(meta.file);
      continue;
    }
    const mine = local.latest.get(r.event.blockId);
    const w = winners.get(r.event.blockId) ?? { meta: r.meta };
    if (isContent(r.event)) {
      const best = w.content ? eventKey(w.content.event) : mine?.content;
      if (!best || compareKeys(eventKey(r.event), best) > 0) w.content = r;
    } else if (r.event.op === "props") {
      const best = w.props ? eventKey(w.props.event) : mine?.props;
      if (!best || compareKeys(eventKey(r.event), best) > 0) w.props = r;
    }
    winners.set(r.event.blockId, w);
  }

  const blocks: MergePlan["blocks"] = [];
  for (const [blockId, w] of winners) {
    if (!w.content && !w.props) continue;
    const newest = [w.content, w.props].filter(Boolean).map((r) => r!.event.createdAt).sort().pop()!;
    blocks.push({ blockId, meta: w.meta, content: w.content?.event.after, props: w.props?.event.after, updatedAt: newest });
  }
  return { events: fresh, blocks, files };
}

/** A device's month file, e.g. "2026-10" for events/<device>/2026-10.jsonl. */
export const monthOf = (createdAt: string) => createdAt.slice(0, 7);

export const toLines = (records: SyncRecord[]) => records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");

/** Reads a .jsonl sync file, skipping a half-written last line (the cloud may still be uploading it). */
export function fromLines(text: string): SyncRecord[] {
  const out: SyncRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SyncRecord;
      if (r?.event?.id && r.meta) out.push(r);
    } catch {
      // Incomplete line; it will be complete next time.
    }
  }
  return out;
}

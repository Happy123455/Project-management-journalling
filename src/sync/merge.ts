import type { JSONContent } from "@tiptap/react";
import type { FileRecord, JournalEvent } from "../store/types";
import { siblingIds } from "./lineIds";

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
  /**
   * For blocks that already have text here: the current document and every earlier document
   * this device's log moved away from (event `before`s): current as a `docKey`, befores as `beforeKey(docKey)`. Lets a merge tell
   * "the other device built on my text" from "both devices wrote without seeing each other".
   */
  docs?: Map<string, { current: string; befores: Set<string> }>;
}

/** What to change locally. Applying it twice changes nothing more (imports are idempotent). */
export interface MergePlan {
  /** Events to add to the local log, oldest first. */
  events: SyncRecord[];
  /** Blocks whose content and/or props should be replaced by a newer remote version. */
  blocks: { blockId: string; meta: BlockMeta; content?: string; props?: string; updatedAt: string; merged?: boolean }[];
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
    const kept = keepBothSides(local, blockId, w.content, fresh);
    const content = kept ? kept.content : w.content?.event.after;
    if (!content && !w.props) continue;
    const newest = [w.content, w.props].filter(Boolean).map((r) => r!.event.createdAt).sort().pop() ?? kept!.updatedAt;
    blocks.push({ blockId, meta: w.meta, content, props: w.props?.event.after, updatedAt: newest, merged: kept?.merged });
  }
  return { events: fresh, blocks, files };
}

/** A document as a comparable string, whatever event shape it came from. */
export const docKey = (after: string) => JSON.stringify(eventDocument(after));

/**
 * A short fingerprint of a docKey (cyrb53), for LocalState.docs befores: a block's history can hold
 * hundreds of whole documents, too many to keep in memory as text.
 */
export function beforeKey(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36)}.${(h1 >>> 0).toString(36)}.${key.length}`;
}

const isEmpty = (doc: JSONContent) => !doc.content?.some((n) => n.type !== "paragraph" || n.content?.length);

/**
 * Never lose text: when this device and another wrote on the same block without either having
 * seen the other's version, keep the newer document and add back every paragraph/block that only
 * the other side has, in its place. When one side simply continued the other's text, the newer
 * one is taken as it is (so deletions stay deleted).
 * Returns null to leave the plain last-writer-wins result.
 */
function keepBothSides(
  local: LocalState,
  blockId: string,
  remoteWinner: SyncRecord | undefined,
  fresh: SyncRecord[],
): { content?: string; merged: boolean; updatedAt: string } | null {
  const mine = local.docs?.get(blockId);
  const remote = fresh.filter((r) => r.event.blockId === blockId && isContent(r.event));
  if (!mine || !remote.length) return null;
  const mineDoc = eventDocument(mine.current);
  if (isEmpty(mineDoc)) return null;
  const theirs = remote[remote.length - 1];
  const theirsKey = docKey(theirs.event.after!);
  // They built on what this device has: their newest text already contains our changes.
  const theyContinued = remote.some((r) => (r.event.before && docKey(r.event.before) === mine.current) || docKey(r.event.after!) === mine.current);
  // This device built on their newest text.
  const weContinued = mine.current === theirsKey || mine.befores.has(beforeKey(theirsKey));
  if (remoteWinner ? theyContinued : weContinued) return null;
  if (remoteWinner && weContinued) return { content: undefined, merged: false, updatedAt: theirs.event.createdAt };
  if (!remoteWinner && theyContinued) return null;
  const newer = remoteWinner ? eventDocument(theirs.event.after!) : mineDoc;
  const older = remoteWinner ? mineDoc : eventDocument(theirs.event.after!);
  const both = mergeDocs(newer, older, commonBase(mine, remote));
  const key = JSON.stringify(both);
  if (key === mine.current) return remoteWinner ? { content: undefined, merged: false, updatedAt: theirs.event.createdAt } : null;
  if (key === theirsKey) return remoteWinner ? null : { content: theirs.event.after!, merged: false, updatedAt: theirs.event.createdAt };
  return { content: key, merged: true, updatedAt: [theirs.event.createdAt, new Date().toISOString()].sort().pop()! };
}

/**
 * The last document both devices had: the newest one the other device started an edit from (or
 * reached) that this device also had. A three-way merge from it keeps deletions and edits from
 * both sides instead of adding every changed block back as a copy.
 */
function commonBase(mine: { current: string; befores: Set<string> }, remote: SyncRecord[]): JSONContent | undefined {
  const known = (doc: string | null | undefined) => {
    if (!doc) return false;
    const k = docKey(doc);
    return k === mine.current || mine.befores.has(beforeKey(k));
  };
  for (let i = remote.length - 1; i >= 0; i--) {
    const e = remote[i].event;
    if (known(e.after)) return eventDocument(e.after!);
    if (known(e.before)) return eventDocument(e.before!);
  }
  return undefined;
}

const CONTAINERS = new Set(["bulletList", "orderedList", "taskList", "blockquote", "listItem", "taskItem"]);

/** How many children two container blocks share. */
function overlap(a: JSONContent, b: JSONContent): number {
  const keys = new Set((a.content ?? []).map((n) => JSON.stringify(n)));
  return (b.content ?? []).filter((n) => keys.has(JSON.stringify(n))).length;
}

/** Two versions of the same list or quote: same kind, and at least half their items in common. */
function similar(a: JSONContent, b: JSONContent): boolean {
  if (a.type !== b.type || !CONTAINERS.has(a.type ?? "") || !a.content?.length || !b.content?.length) return false;
  return overlap(a, b) * 2 >= Math.min(a.content.length, b.content.length);
}

/** Attributes that only say how a block looks (size, placement, folded, preview details), not what it is. */
const LOOK = new Set(["lid", "born", "width", "height", "align", "x", "y", "units", "collapsed", "status", "title", "site", "image"]);
const identity = (n: JSONContent) => {
  const a = n.attrs ?? {};
  // A link card's title/site/image come from its url; a prompt's title is part of what it is.
  const keys = Object.keys(a).filter((k) => !LOOK.has(k) || (n.type === "promptBlock" && k === "title")).sort();
  return keys.length ? keys.map((k) => [k, a[k]]) : undefined;
};

/**
 * A block without its look: the same text or media, whatever its size or placement. What it is
 * stays in the key (a photo's file, a link card's url): before 31 Oct every link card (and every
 * photo) looked the same here, so a merge kept only one and dropped the rest.
 */
export function looseKey(node: JSONContent): string {
  const strip = (n: JSONContent): unknown => ({
    t: n.type,
    a: identity(n),
    x: n.text,
    m: n.marks?.map((m) => (m.attrs?.href ? `${m.type}:${m.attrs.href}` : m.type)),
    c: n.content?.map(strip),
  });
  return JSON.stringify(strip(node));
}

/**
 * `newer`'s lines, plus each line only `older` added, placed after its neighbour from `older`.
 * Lines are matched by their hidden id (sync/lineIds.ts; made from content for lines without
 * one), so one line written further on either device stays one line: the half-typed versions
 * that used to pile up as extra lines ("Hel", "Hello wo", "Hello world") are now versions of it.
 * With `base` (the last version both had), lines `older` deleted are dropped from `newer` too,
 * unless `newer` changed them; a line both changed keeps the version that contains the other's
 * text, else both edits when they touch different parts of it, else newer's (and older's as a
 * line under it, so no text is lost). A block that only differs in look (a resized clip, a moved
 * photo) is never added twice: the 30 Oct face palm clip came back as four copies.
 */
export function mergeDocs(newer: JSONContent, older: JSONContent, base?: JSONContent): JSONContent {
  return { ...newer, content: mergeLines(newer.content ?? [], older.content ?? [], base?.content) };
}

const same = (a: JSONContent | undefined, b: JSONContent | undefined) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
const isBlockList = (nodes: JSONContent[] | undefined) => !!nodes?.length && nodes.every((n) => n.type !== "text" && n.type !== "hardBreak");

function mergeLines(newer: JSONContent[], older: JSONContent[], base?: JSONContent[]): JSONContent[] {
  const idsN = siblingIds(newer);
  const idsO = siblingIds(older);
  const byO = new Map(idsO.map((id, i) => [id, older[i]]));
  const byB = new Map<string, JSONContent>();
  if (base) siblingIds(base).forEach((id, i) => byB.set(id, base[i]));
  const out: JSONContent[] = [];
  const outIds: string[] = [];
  newer.forEach((n, i) => {
    const id = idsN[i];
    const o = byO.get(id);
    const b = byB.get(id);
    if (!o) {
      // `older` deleted it and `newer` left it as it was.
      if (b && same(n, b)) return;
      out.push(n);
      outIds.push(id);
      return;
    }
    for (const [k, m] of mergeLine(n, o, b).entries()) {
      out.push(m);
      outIds.push(k ? `${id}~${k}` : id);
    }
  });
  const loose = new Set(out.map(looseKey));
  let after = -1; // index in `out` of the last `older` line placed or found
  older.forEach((o, i) => {
    const id = idsO[i];
    const at = outIds.indexOf(id);
    if (at >= 0) {
      after = Math.max(after, at);
      return;
    }
    const b = byB.get(id);
    // `newer` deleted it, and `older` didn't change it since.
    if (b && same(o, b)) return;
    if (o.type === "paragraph" && !o.content?.length) return;
    // Same text or media as a line `newer` has, only resized or moved (or without an id).
    const lk = looseKey(o);
    if (loose.has(lk)) {
      const j = out.findIndex((n) => looseKey(n) === lk);
      if (j > after) after = j;
      return;
    }
    // An old list (no ids) both sides changed: merge its items instead of keeping two lists.
    if (!o.attrs?.lid) {
      const twin = out.findIndex((n, j) => j > after - 1 && !n.attrs?.lid && similar(n, o));
      const sim = twin >= 0 ? twin : out.findIndex((n) => !n.attrs?.lid && similar(n, o));
      if (sim >= 0) {
        const baseTwin = base?.filter((x) => similar(x, o)).sort((x, y) => overlap(y, o) - overlap(x, o))[0];
        out[sim] = mergeDocs(out[sim], o, baseTwin);
        loose.add(looseKey(out[sim]));
        after = sim;
        return;
      }
    }
    out.splice(after + 1, 0, o);
    outIds.splice(after + 1, 0, id);
    loose.add(lk);
    after += 1;
  });
  return out;
}

const plainText = (n: JSONContent): string | null => {
  if (!n.content?.length) return "";
  if (n.content.some((c) => c.type !== "text" || c.marks?.length)) return null;
  return n.content.map((c) => c.text ?? "").join("");
};
const textOf = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(textOf).join("");

/** One line as both sides left it: one version, or two when they can't be put together. */
function mergeLine(n: JSONContent, o: JSONContent, b?: JSONContent): JSONContent[] {
  if (same(n, o)) return [n];
  if (b && same(n, b)) return [o];
  if (b && same(o, b)) return [n];
  // A list, quote or list item both changed: merge what's inside, line by line.
  if (isBlockList(n.content) && isBlockList(o.content) && n.type === o.type) {
    return [{ ...n, content: mergeLines(n.content!, o.content!, isBlockList(b?.content) ? b!.content : undefined) }];
  }
  if (n.type === o.type && looseKey(n) === looseKey(o)) return [n];
  const tn = textOf(n);
  const to = textOf(o);
  // One is the other written further (or the same text restyled): the fuller one.
  if (tn.includes(to)) return [n];
  if (to.includes(tn)) return [o];
  // Both typed in different parts of the line: both edits.
  const pn = plainText(n);
  const po = plainText(o);
  const pb = b ? plainText(b) : null;
  if (pn !== null && po !== null && pb !== null) {
    const both = merge3(pb, po, pn);
    if (both !== null) return [{ ...n, content: both ? [{ type: "text", text: both }] : undefined }];
  }
  return [n, { ...o, attrs: { ...(o.attrs ?? {}), lid: null } }];
}

/** Three-way merge of one line's text; null when both changed the same part. */
export function merge3(base: string, a: string, b: string): string | null {
  const span = (x: string) => {
    let s = 0;
    while (s < base.length && s < x.length && base[s] === x[s]) s++;
    let e = 0;
    while (e < base.length - s && e < x.length - s && base[base.length - 1 - e] === x[x.length - 1 - e]) e++;
    return { from: s, to: base.length - e, text: x.slice(s, x.length - e) };
  };
  const ea = span(a);
  const eb = span(b);
  if (ea.to < eb.from || (ea.to === eb.from && ea.from < eb.from)) return base.slice(0, ea.from) + ea.text + base.slice(ea.to, eb.from) + eb.text + base.slice(eb.to);
  if (eb.to < ea.from || (eb.to === ea.from && eb.from < ea.from)) return base.slice(0, eb.from) + eb.text + base.slice(eb.to, ea.from) + ea.text + base.slice(ea.to);
  return null;
}

/**
 * The document in a content event. Day events hold it directly; a named page's create event
 * holds { title, content }.
 */
export function eventDocument(after: string): JSONContent {
  const parsed = JSON.parse(after);
  return parsed?.type === "doc" ? parsed : (parsed?.content ?? { type: "doc", content: [] });
}

/** A device's month file, e.g. "2026-10" for events/<device>/2026-10.jsonl. */
export const monthOf = (createdAt: string) => createdAt.slice(0, 7);

/**
 * Sync files carry only what changed. Each event used to hold its whole note twice (before and
 * after), so a few minutes of typing on a long day went up as many megabytes. Now, inside one
 * file, an event's `before` that is the previous event's `after` is written as SAME, and `after`
 * as the lines that differ from `before` (by line id) plus their order. Everything needed to read
 * an event back is earlier in the same file, so no file depends on another arriving.
 */
const SAME = "\u0001same";
const DELTA = "\u0001d";

interface Delta {
  /** Line ids, in order. */
  k: string[];
  /** Lines that are new or changed, by id. */
  n: Record<string, JSONContent>;
  /** The document without its lines. */
  x: JSONContent;
}

const asDoc = (s: string | null | undefined): JSONContent | null => {
  if (!s || s.startsWith("\u0001")) return null;
  try {
    const d = JSON.parse(s);
    return d?.type === "doc" ? d : null;
  } catch {
    return null;
  }
};

export function docDelta(after: JSONContent, before: JSONContent): Delta {
  const lines = after.content ?? [];
  const k = siblingIds(lines);
  const old = before.content ?? [];
  const oldIds = siblingIds(old);
  const had = new Map(oldIds.map((id, i) => [id, JSON.stringify(old[i])]));
  const n: Record<string, JSONContent> = {};
  lines.forEach((line, i) => {
    if (had.get(k[i]) !== JSON.stringify(line)) n[k[i]] = line;
  });
  const { content: _, ...x } = after;
  return { k, n, x };
}

export function applyDelta(before: JSONContent, d: Delta): JSONContent {
  const old = before.content ?? [];
  const byId = new Map(siblingIds(old).map((id, i) => [id, old[i]]));
  const content = d.k.map((id) => {
    const line = d.n[id] ?? byId.get(id);
    if (!line) throw new Error("sync file: line missing");
    return line;
  });
  return { ...d.x, content };
}

export function toLines(records: SyncRecord[]): string {
  const last = new Map<string, string>();
  const out: string[] = [];
  for (const r of records) {
    const e = r.event;
    if (!isContent(e) || !e.after) {
      out.push(JSON.stringify(r));
      continue;
    }
    const before = e.before && e.before === last.get(e.blockId) ? SAME : e.before;
    const beforeDoc = asDoc(e.before);
    const afterDoc = beforeDoc && asDoc(e.after);
    let after = e.after;
    if (beforeDoc && afterDoc) {
      const packed = DELTA + JSON.stringify(docDelta(afterDoc, beforeDoc));
      if (packed.length < after.length) after = packed;
    }
    last.set(e.blockId, e.after);
    out.push(JSON.stringify({ ...r, event: { ...e, before, after } }));
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

/** Reads a .jsonl sync file, skipping a half-written last line (the cloud may still be uploading it). */
export function fromLines(text: string): SyncRecord[] {
  const out: SyncRecord[] = [];
  const last = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SyncRecord;
      if (!r?.event?.id || !r.meta) continue;
      const e = r.event;
      if (e.before === SAME) e.before = last.get(e.blockId) ?? null;
      if (e.after?.startsWith(DELTA)) {
        const base = asDoc(e.before);
        if (!base) continue;
        e.after = JSON.stringify(applyDelta(base, JSON.parse(e.after.slice(DELTA.length))));
      }
      if (isContent(e) && e.after) last.set(e.blockId, e.after);
      out.push(r);
    } catch {
      // Incomplete line; it will be complete next time.
    }
  }
  return out;
}

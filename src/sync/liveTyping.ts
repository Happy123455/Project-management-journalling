import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import { mergeDocs, takeMergeNotes } from "./merge";
import { logAnomaly, short } from "./anomalies";
import { siblingIds } from "./lineIds";

/**
 * Letter-by-letter typing over the Wi-Fi link (see direct.ts). While the link is up, each change
 * in an open note is sent at once as a small patch (the top-level paragraphs that changed), and
 * the other device puts it into its open note in place: the cursor stays where it is and the
 * patch is not saved there as its own edit. The real save (an event, merged as always) follows
 * a second later, and finds the same text already there, so nothing is applied twice.
 * A patch that doesn't fit (a message was missed) is skipped until the next full copy, sent every
 * couple of seconds while typing.
 */
export interface TypingMsg {
  /** Which note: "day:2026-11-01". */
  key: string;
  device: string;
  seq: number;
  /** Date.now() on the sending device when sent (for the anomaly log's timings). */
  at?: number;
  /** Whole note (first message, or every few seconds). */
  full?: unknown;
  /** Replace top-level nodes [from, from + remove) of a note with `base` nodes by `nodes`. */
  from?: number;
  remove?: number;
  base?: number;
  nodes?: unknown[];
}

/** The transaction meta that marks a change from the other device (not saved, not undone). */
export const REMOTE = "liveRemote";

let sink: ((m: TypingMsg) => void) | null = null;
let device = "";
/** Set by the sync while the Wi-Fi link is up; null otherwise (then nothing is sent). */
export function setTypingSink(me: string, send: ((m: TypingMsg) => void) | null) {
  device = me;
  sink = send;
}

/** A full copy (the fallback when a patch was missed) goes at most this often; patches carry the rest. */
const FULL_EVERY_MS = 8000;
/**
 * At most one message per note this often: fast typing is sent as one patch per 250 ms instead of
 * one request per key (8 Nov battery: ~58k Wi-Fi packets a day). The last keys always go out.
 */
const SEND_EVERY_MS = 250;
const out = new Map<string, { seq: number; fullAt: number; prev: PMNode }>();
const lastSent = new Map<string, number>();
const waiting = new Map<string, { doc: PMNode }>();

/** Top-level children that differ between two docs: [from, removeCount, newNodes]. */
export function diffChildren(a: PMNode, b: PMNode): [number, number, PMNode[]] {
  const same = (x: PMNode, y: PMNode) => x === y || x.eq(y);
  let start = 0;
  while (start < a.childCount && start < b.childCount && same(a.child(start), b.child(start))) start++;
  let endA = a.childCount;
  let endB = b.childCount;
  while (endA > start && endB > start && same(a.child(endA - 1), b.child(endB - 1))) {
    endA--;
    endB--;
  }
  const nodes: PMNode[] = [];
  for (let i = start; i < endB; i++) nodes.push(b.child(i));
  return [start, endA - start, nodes];
}

/** The editor changed (not by the other device): send it (now, or with the next batch). */
export function sendTyping(key: string, doc: PMNode) {
  if (!sink) return void out.delete(key);
  const w = waiting.get(key);
  if (w) return void (w.doc = doc);
  const wait = (lastSent.get(key) ?? 0) + SEND_EVERY_MS - Date.now();
  if (wait <= 0) return sendNow(key, doc);
  window.setTimeout(() => {
    const later = waiting.get(key);
    waiting.delete(key);
    if (later) sendNow(key, later.doc);
  }, wait);
  waiting.set(key, { doc });
}

function sendNow(key: string, doc: PMNode) {
  if (!sink) return void out.delete(key);
  lastSent.set(key, Date.now());
  const now = Date.now();
  const o = out.get(key);
  if (!o || now - o.fullAt > FULL_EVERY_MS) {
    const seq = (o?.seq ?? Date.now()) + 1; // from the clock: a restarted app still counts up
    out.set(key, { seq, fullAt: now, prev: doc });
    return sink({ key, device, seq, at: now, full: doc.toJSON() });
  }
  if (o.prev === doc) return;
  const [from, remove, nodes] = diffChildren(o.prev, doc);
  o.seq++;
  const base = o.prev.childCount;
  o.prev = doc;
  sink({ key, device, seq: o.seq, at: now, from, remove, base, nodes: nodes.map((n) => n.toJSON()) });
}

const seen = new Map<string, number>();
/** The other device's note as its messages built it up, per device and note. */
const theirs = new Map<string, PMNode>();

/**
 * Puts the other device's typing into this open note; false when it doesn't fit (wait for a full
 * copy). Their note is merged into this one line by line (sync/merge.ts mergeDocs, matched by the
 * hidden line ids), never copied over it: a line only this device has stays, and a line goes only
 * when the other device had it in its previous message and removed it since. Before 8 Nov a full
 * copy replaced the whole open note, so lines the phone had that the Mac's open note didn't yet
 * (typed earlier, not merged there yet) vanished from the phone and its next save deleted them.
 */
export function applyTyping(editor: Editor, m: TypingMsg): boolean {
  if (editor.isDestroyed) return false;
  const slot = `${m.device}|${m.key}`;
  const last = seen.get(slot);
  const schema: Schema = editor.schema;
  const doc = editor.state.doc;
  const tr = editor.state.tr;
  try {
    const before = theirs.get(slot);
    let next: PMNode;
    if (m.full !== undefined) {
      if (last !== undefined && m.seq <= last) return false;
      next = schema.nodeFromJSON(m.full);
    } else {
      if (last === undefined || m.seq !== last + 1 || !before || before.childCount !== m.base) {
        logAnomaly({
          kind: "unreadable",
          path: "wifi-typing",
          note: m.key,
          text: last !== undefined && m.seq > last + 1 ? `missed ${m.seq - last - 1} typing message(s); waiting for the next full copy` : "typing patch didn't fit this note; waiting for the next full copy",
          detail: { device: m.device, seq: m.seq, last, sentAt: m.at, lagMs: m.at ? Date.now() - m.at : undefined },
        });
        return false;
      }
      next = patched(before, m.from!, m.remove!, (m.nodes ?? []).map((n) => schema.nodeFromJSON(n)));
    }
    seen.set(slot, m.seq);
    theirs.set(slot, next);
    if (next.eq(doc)) return true;
    // A sync import (App.tsx, only with nothing unsaved here) is the merged saved note: taken as it is.
    const base = m.device === "sync" ? doc : before;
    takeMergeNotes();
    const mergedJson = mergeDocs(next.toJSON(), doc.toJSON(), base?.toJSON(), false);
    if (m.device !== "sync") noteTyping(m, doc, mergedJson);
    const merged = schema.nodeFromJSON(mergedJson);
    if (merged.eq(doc)) return true;
    const [from, remove, nodes] = diffChildren(doc, merged);
    replace(tr, doc, from, remove, nodes);
  } catch {
    return false;
  }
  if (!tr.docChanged) return true;
  editor.view.dispatch(tr.setMeta(REMOTE, true).setMeta("addToHistory", false));
  // What this device sends next is measured from the note as it is now.
  const o = out.get(m.key);
  if (o && o.prev.type.schema === editor.schema) o.prev = editor.state.doc;
  // Keys waiting to go out were typed before this arrived: send the note as it is now instead.
  const w = waiting.get(m.key);
  if (w) w.doc = editor.state.doc;
  return true;
}

/** `doc` with top-level children [from, from + remove) replaced by `nodes`. */
function patched(doc: PMNode, from: number, remove: number, nodes: PMNode[]): PMNode {
  const kids: PMNode[] = [];
  doc.forEach((c, _o, i) => {
    if (i === from) kids.push(...nodes);
    if (i < from || i >= from + remove) kids.push(c);
  });
  if (from >= doc.childCount) kids.push(...nodes);
  return doc.copy(Fragment.from(kids));
}

function replace(tr: Editor["state"]["tr"], doc: PMNode, from: number, remove: number, nodes: PMNode[]) {
  let start = 0;
  for (let i = 0; i < from; i++) start += doc.child(i).nodeSize;
  let end = start;
  for (let i = from; i < from + remove; i++) end += doc.child(i).nodeSize;
  tr.replaceWith(start, end, nodes);
}

/** Open notes listen here for the other device's typing. */
export const TYPING_EVENT = "journal:typing";
export function receiveTyping(m: TypingMsg) {
  window.dispatchEvent(new CustomEvent<TypingMsg>(TYPING_EVENT, { detail: m }));
}

const textOf = (n: { text?: string; content?: unknown[] }): string => (n.text ?? "") + ((n.content ?? []) as { text?: string }[]).map(textOf).join("");

/** Clashes and lines taken out by the other device's typing, for the anomaly log. */
function noteTyping(m: TypingMsg, doc: PMNode, merged: ReturnType<typeof mergeDocs>) {
  const timing = { device: m.device, seq: m.seq, sentAt: m.at, lagMs: m.at ? Date.now() - m.at : undefined };
  for (const n of takeMergeNotes())
    logAnomaly({ kind: n.kind, path: "wifi-typing", note: m.key, text: Object.entries(n.texts).map(([k, v]) => `${k}: "${short(v, 60)}"`).join(" / "), detail: { ...timing, line: n.line, texts: n.texts } });
  const before = doc.toJSON().content ?? [];
  const kept = new Set(siblingIds(merged.content ?? []));
  const ids = siblingIds(before);
  const gone = before.filter((n: { text?: string; content?: unknown[] }, i: number) => !kept.has(ids[i]) && textOf(n).trim()).map((n: { text?: string; content?: unknown[] }) => short(textOf(n)));
  if (gone.length) logAnomaly({ kind: "lines-removed", path: "wifi-typing", note: m.key, text: `${gone.length} line(s) removed by the other device's typing: ${gone.join(" · ")}`, detail: { ...timing, lines: gone } });
}

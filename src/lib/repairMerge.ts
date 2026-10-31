import type { JSONContent } from "@tiptap/react";
import type { JournalEvent, JournalStore } from "../store";
import { eventDocument, looseKey } from "../sync/merge";
import { docText } from "./words";

/**
 * Recovery for the merge bug fixed on 31 Oct: when both devices had written on a day, the merge
 * treated every link card (and every photo, clip, YouTube player) as the same block, so all but
 * one were dropped. The dropped ones are still in the history: in the `before` of the "sync" edit
 * that lost them. A thing is put back only if no later version of the note had it again (so
 * something deleted on purpose afterwards stays deleted).
 */

/** What a media node is: a link card's url, a file's id, a player's url. */
function ident(n: JSONContent): string | null {
  const a = n.attrs ?? {};
  if (n.type === "linkCard" && a.url) return `link:${a.url}`;
  if ((n.type === "attachmentImage" || n.type === "attachmentMedia" || n.type === "attachmentFile") && a.fileId) return `file:${a.fileId}`;
  if (n.type === "youtubeEmbed" && a.url) return `yt:${a.url}`;
  return null;
}

function idsIn(n: JSONContent, out = new Set<string>()): Set<string> {
  const id = ident(n);
  if (id) out.add(id);
  for (const c of n.content ?? []) idsIn(c, out);
  return out;
}

const unescape = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
};

/** The same ids as `idsIn`, read from a stored document's JSON text without parsing it. */
export function idsInText(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const m of raw.matchAll(/"type":"linkCard","attrs":\{(?:[^{}]|\{[^{}]*\})*?"url":"((?:[^"\\]|\\.)*)"/g)) out.add(`link:${unescape(m[1])}`);
  for (const m of raw.matchAll(/"fileId":"((?:[^"\\]|\\.)*)"/g)) out.add(`file:${unescape(m[1])}`);
  for (const m of raw.matchAll(/"type":"youtubeEmbed","attrs":\{(?:[^{}]|\{[^{}]*\})*?"url":"((?:[^"\\]|\\.)*)"/g)) out.add(`yt:${unescape(m[1])}`);
  return out;
}

const parse = (s: string | null | undefined): JSONContent | null => {
  if (!s) return null;
  try {
    return eventDocument(s);
  } catch {
    return null;
  }
};

/** The smallest block holding a lost thing: the card itself, or the paragraph with the photo. */
function carriers(doc: JSONContent, lost: Set<string>): { node: JSONContent; prev: JSONContent | null; next: JSONContent | null; parent: JSONContent }[] {
  const found: ReturnType<typeof carriers> = [];
  const walk = (parent: JSONContent) => {
    const kids = parent.content ?? [];
    kids.forEach((n, i) => {
      const id = ident(n);
      const here = id && lost.has(id);
      const inlineHere = n.type === "paragraph" && (n.content ?? []).some((c) => {
        const cid = ident(c);
        return !!cid && lost.has(cid);
      });
      if (here || inlineHere) found.push({ node: n, prev: kids[i - 1] ?? null, next: kids[i + 1] ?? null, parent });
      else walk(n);
    });
  };
  walk(doc);
  return found;
}

/** Where a block with this look sits in `doc`: its parent and index, or null. */
function locate(doc: JSONContent, key: string): { parent: JSONContent; index: number } | null {
  const kids = doc.content ?? [];
  for (let i = 0; i < kids.length; i++) {
    if (looseKey(kids[i]) === key) return { parent: doc, index: i };
    const deeper = locate(kids[i], key);
    if (deeper) return deeper;
  }
  return null;
}

/** For one note: the document with the lost cards and media back in place, or null when nothing was lost. */
export function restoreMerged(events: JournalEvent[], current: JSONContent): { content: JSONContent; restored: string[] } | null {
  const versions = events.filter((e) => e.op === "create" || e.op === "update" || e.op === "restore");
  const now = idsIn(current);
  // Notes hold many full-document versions; reading the ids straight from the stored text keeps this
  // light on the phone. Only the versions things are restored from get parsed.
  const ids = new Map<string | null, Set<string>>();
  const rawIds = (raw: string | null) => {
    let got = ids.get(raw);
    if (!got) ids.set(raw, (got = idsInText(raw)));
    return got;
  };
  // Removed on purpose: an edit (on any device, not a merge) that had it before and not after.
  const deleted = new Set<string>();
  for (const e of versions) {
    if (e.actor === "sync" || !e.before) continue;
    const kept = rawIds(e.after);
    for (const id of rawIds(e.before)) if (!kept.has(id)) deleted.add(id);
  }
  const lostRaw = new Map<string, string>(); // id -> the newest version that had it
  for (const e of versions) for (const id of rawIds(e.after)) if (!now.has(id) && !deleted.has(id)) lostRaw.set(id, e.after);
  const lost = new Map<string, JSONContent>();
  const parsed = new Map<string, JSONContent | null>();
  for (const [id, raw] of lostRaw) {
    if (!parsed.has(raw)) parsed.set(raw, parse(raw));
    const doc = parsed.get(raw);
    if (doc && idsIn(doc).has(id)) lost.set(id, doc);
  }
  if (!lost.size) return null;
  const content = structuredClone(current) as JSONContent;
  content.content ??= [];
  const restored: string[] = [];
  const done = new Set<string>();
  for (const [, from] of lost) {
    for (const c of carriers(from, new Set([...lost.keys()].filter((k) => !done.has(k))))) {
      const ids = [...idsIn(c.node)].filter((id) => lost.has(id) && !done.has(id));
      if (!ids.length) continue;
      const node = structuredClone(c.node) as JSONContent;
      const prev = c.prev ? locate(content, looseKey(c.prev)) : null;
      const next = !prev && c.next ? locate(content, looseKey(c.next)) : null;
      if (prev) prev.parent.content!.splice(prev.index + 1, 0, node);
      else if (next) next.parent.content!.splice(next.index, 0, node);
      else content.content.push(node);
      for (const id of idsIn(node)) done.add(id);
      restored.push(...ids);
    }
  }
  return restored.length ? { content, restored } : null;
}

/** Runs the recovery over the days since the bug could happen; returns how many things came back. */
export async function repairMergeLosses(store: JournalStore, since = "2026-10-20"): Promise<number> {
  let total = 0;
  for (const day of (await store.listDays()).filter((d) => d >= since)) {
    // Let the app breathe between days.
    await new Promise((r) => setTimeout(r, 30));
    const page = await store.getDay(day);
    if (!page) continue;
    const fixed = restoreMerged(await store.eventsFor(page.id), page.content);
    if (!fixed) continue;
    await store.saveDay({ day, content: fixed.content, plainText: docText(fixed.content), actor: "repair" });
    total += fixed.restored.length;
  }
  return total;
}

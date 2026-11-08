import type { JSONContent } from "@tiptap/react";
import type { JournalEvent } from "../store/types";
import { eventDocument, looseKey } from "../sync/merge";
import { siblingIds } from "../sync/lineIds";

/** A line that some edit or sync took out of a note and that isn't anywhere in it now. */
export interface RemovedLine {
  id: string;
  node: JSONContent;
  text: string;
  /** When it went, from which device, by whom ("me", "sync", an AI's name). */
  at: string;
  deviceId: string;
  actor: string;
  /** The line it came after then (to put it back in its place), null at the top. */
  after: string | null;
}

const textOf = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(textOf).join(" ");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const isBlank = (n: JSONContent) => n.type === "paragraph" && !norm(textOf(n));

function docOf(s: string | null): JSONContent | null {
  if (!s) return null;
  try {
    return eventDocument(s);
  } catch {
    return null;
  }
}

/**
 * Every top-level line any edit of this note removed (an event's `before` had it, its `after`
 * didn't) that the note doesn't have now, by id, by text, or as the same media. Newest first.
 * The 8 Nov phone loss showed sync can take lines out without anyone deleting them; this is
 * the trail that lets every such line be put back, whatever caused it.
 */
export function removedLines(events: JournalEvent[], current: JSONContent): RemovedLine[] {
  const nowIds = new Set<string>();
  const walk = (nodes: JSONContent[] | undefined) => {
    if (!nodes?.length) return;
    siblingIds(nodes).forEach((id) => nowIds.add(id));
    nodes.forEach((n) => n.type !== "text" && walk(n.content));
  };
  walk(current.content);
  const nowText = norm(textOf(current));
  const nowLoose = new Set((current.content ?? []).map(looseKey));
  const found = new Map<string, RemovedLine>();
  const sorted = [...events].filter((e) => e.op === "update" || e.op === "create").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const e of sorted) {
    const before = docOf(e.before)?.content ?? [];
    const after = docOf(e.after)?.content;
    if (!after || !before.length) continue;
    const afterIds = new Set(siblingIds(after));
    const ids = siblingIds(before);
    before.forEach((n, i) => {
      const id = ids[i];
      if (afterIds.has(id) || isBlank(n) || nowIds.has(id)) return;
      const text = norm(textOf(n));
      if (text ? nowText.includes(text) : nowLoose.has(looseKey(n))) return;
      found.set(id, { id, node: n, text: text || `(${n.type})`, at: e.createdAt, deviceId: e.deviceId, actor: e.actor, after: i ? ids[i - 1] : null });
    });
  }
  return [...found.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** `doc` with `line` put back after the line it followed (or where that one's nearest kept neighbour is), else at the end. */
export function putBack(doc: JSONContent, line: RemovedLine): JSONContent {
  const content = [...(doc.content ?? [])];
  const ids = siblingIds(content);
  let at = content.length;
  if (line.after === null) at = 0;
  else {
    const i = ids.indexOf(line.after);
    if (i >= 0) at = i + 1;
  }
  content.splice(at, 0, line.node);
  return { ...doc, content };
}

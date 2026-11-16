import type { JSONContent } from "@tiptap/react";
import type { MergeNote } from "./merge";
import type { RemovedLine } from "../lib/removedLines";
import { siblingIds } from "./lineIds";

/**
 * Lines a merge left out as echoes of a nearby line (merge.ts foldEchoes), per note, so Nexus ›
 * This note can list them with ↩ like any other removed line. Kept on this device only
 * (localStorage journal.folded, newest first, the last 100).
 */
const KEY = "journal.folded";
const MAX = 100;

interface Folded {
  note: string;
  line: RemovedLine;
}

function read(): Folded[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const textOf = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(textOf).join("");

/** Keeps the "folded" notes of a merge on `note` ("day:2026-11-16"). */
export function recordFolded(note: string | undefined, notes: MergeNote[], deviceId = "sync") {
  const found = notes.filter((n) => n.kind === "folded" && n.node);
  if (!note || !found.length) return;
  try {
    const now = new Date().toISOString();
    const list = read();
    for (const n of found)
      list.unshift({ note, line: { id: n.line, node: n.node!, text: textOf(n.node!).replace(/\s+/g, " ").trim(), at: now, deviceId, actor: "sync (folded echo)", after: n.after ?? null } });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Not kept: the line's text is still in the line it was folded into.
  }
}

/** Folded lines of this note that aren't in it now (newest first). */
export function foldedLines(note: string, current: JSONContent | null): RemovedLine[] {
  const ids = new Set(siblingIds(current?.content ?? []));
  const seen = new Set<string>();
  return read()
    .filter((f) => f.note === note && !ids.has(f.line.id) && !seen.has(f.line.id) && seen.add(f.line.id))
    .map((f) => f.line);
}

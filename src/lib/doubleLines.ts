import type { JSONContent } from "@tiptap/react";
import { siblingIds } from "../sync/lineIds";

/**
 * Nexus › Sync › "Possible double lines": the half-typed copies and duplicates that the old sync
 * left in notes (13 Nov Jensen line, 6 and 7 Nov half paragraphs, the 22 Nov 🎲 line, the
 * "~Phone" clash copies of 10–14 Nov). Only listed: each one is removed when Hapi taps Remove.
 */
export interface Double {
  day: string;
  /** The line that looks like the extra copy (to remove), and the line it doubles (kept). */
  lid: string;
  text: string;
  twinLid: string;
  twin: string;
  why: "copy" | "half" | "clash-copy";
}

const textOf = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(textOf).join("");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const NEAR = 3;
const MIN_HALF = 15;
const MIN_COPY = 20;

/** The suspected extra copies in one note's top-level lines. */
export function findDoubles(day: string, doc: JSONContent | null | undefined): Double[] {
  const lines = doc?.content ?? [];
  const ids = siblingIds(lines);
  const texts = lines.map((n) => (n.type === "paragraph" || n.type === "heading" ? norm(textOf(n)) : ""));
  const out: Double[] = [];
  const taken = new Set<number>();
  const add = (extra: number, kept: number, why: Double["why"]) => {
    if (taken.has(extra) || taken.has(kept)) return;
    taken.add(extra);
    out.push({ day, lid: ids[extra], text: texts[extra], twinLid: ids[kept], twin: texts[kept], why });
  };
  // A clash copy ("<id>~Phone") next to its line with the same text, or the start of it.
  lines.forEach((_, i) => {
    const m = /^(.+)~[A-Za-z0-9]+$/.exec(ids[i]);
    if (!m || !texts[i]) return;
    const j = ids.indexOf(m[1]);
    if (j < 0 || !texts[j]) return;
    const [a, b] = [texts[i], texts[j]];
    if (a === b || b.startsWith(a)) add(i, j, "clash-copy");
    else if (a.startsWith(b)) add(j, i, "clash-copy");
  });
  // Near each other: the same text twice, or the start of a line next to the whole line.
  for (let i = 0; i < lines.length; i++) {
    const a = texts[i];
    if (!a) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + NEAR); j++) {
      const b = texts[j];
      if (!b) continue;
      if (a === b && a.length >= MIN_COPY) add(j, i, "copy");
      else if (a.length >= MIN_HALF && b.length > a.length && b.startsWith(a)) add(i, j, "half");
      else if (b.length >= MIN_HALF && a.length > b.length && a.startsWith(b)) add(j, i, "half");
    }
  }
  return out;
}

/** The note without the top-level line `lid` (only if it still has that text); null when it changed. */
export function withoutLine(doc: JSONContent, d: Pick<Double, "lid" | "text">): JSONContent | null {
  const lines = doc.content ?? [];
  const ids = siblingIds(lines);
  const i = ids.indexOf(d.lid);
  if (i < 0 || norm(textOf(lines[i])) !== d.text) return null;
  return { ...doc, content: lines.filter((_, k) => k !== i) };
}

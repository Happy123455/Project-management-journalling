/**
 * Word-by-word corrections (Hapi, 18 Nov): when the AI fixes the grammar of a paragraph or improves
 * it, the change is shown like an editor at work, one word or phrase at a time. This file is the
 * pure part: what changed (a word diff with inserts, deletes and replacements) and a short reason
 * for each change. correctRun.ts plays it.
 */

export interface Tok {
  /** The word or mark. */
  w: string;
  /** The space after it (as written). */
  sp: string;
}

export type OpKind = "same" | "ins" | "del" | "rep";

export interface Op {
  kind: OpKind;
  /** Old tokens (same, del, rep). */
  a: Tok[];
  /** New tokens (same, ins, rep). */
  b: Tok[];
}

export interface Change {
  /** Index into the ops list. */
  op: number;
  kind: Exclude<OpKind, "same">;
  /** What kind of fix it is (Spelling, Punctuation…). */
  label: string;
  /** One line: what changed. */
  detail: string;
}

/** Words, numbers (with ' and -) and single marks, each with the space that follows it. */
export function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /([\p{L}\p{N}][\p{L}\p{N}'’\-]*|[^\s\p{L}\p{N}])(\s*)/gu;
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  for (const m of text.slice(lead.length).matchAll(re)) out.push({ w: m[1], sp: m[2] });
  return out;
}

const MAX_CELLS = 250_000;

/** The diff: runs of same words, with deletes + inserts between them joined into replacements. */
export function diffOps(before: string, after: string): Op[] {
  const a = tokens(before);
  const b = tokens(after);
  const pairs: [number, number][] = [];
  if (a.length * b.length <= MAX_CELLS) {
    const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i].w === b[j].w ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (a[i].w === b[j].w) (pairs.push([i, j]), i++, j++);
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
  }
  const ops: Op[] = [];
  const push = (kind: OpKind, ta: Tok[], tb: Tok[]) => {
    if (!ta.length && !tb.length) return;
    const last = ops[ops.length - 1];
    if (last && last.kind === kind && kind === "same") return void (last.a.push(...ta), last.b.push(...tb));
    ops.push({ kind, a: ta, b: tb });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    const da = a.slice(i, pi);
    const db = b.slice(j, pj);
    if (da.length && db.length) push("rep", da, db);
    else if (da.length) push("del", da, []);
    else if (db.length) push("ins", [], db);
    if (pi < a.length) push("same", [a[pi]], [b[pj]]);
    i = pi + 1;
    j = pj + 1;
  }
  return splitReplacements(ops);
}

/**
 * A replacement of several words that are mostly one-to-one fixes ("recieve teh" → "receive the")
 * reads better as one change per word.
 */
function splitReplacements(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.kind !== "rep" || op.a.length + op.b.length < 3 || op.a.length > 10 || op.b.length > 10) {
      out.push(op);
      continue;
    }
    // Line the words up where they're near-misses of each other; the rest are inserts or deletes.
    const a = op.a;
    const b = op.b;
    const bits: Op[] = [];
    let i = 0;
    let j = 0;
    let near = 0;
    while (i < a.length && j < b.length) {
      if (close(a[i].w, b[j].w)) (bits.push({ kind: "rep", a: [a[i++]], b: [b[j++]] }), near++);
      else if (j + 1 < b.length && close(a[i].w, b[j + 1].w)) bits.push({ kind: "ins", a: [], b: [b[j++]] });
      else if (i + 1 < a.length && close(a[i + 1].w, b[j].w)) bits.push({ kind: "del", a: [a[i++]], b: [] });
      else bits.push({ kind: "rep", a: [a[i++]], b: [b[j++]] });
    }
    if (i < a.length) bits.push({ kind: "del", a: a.slice(i), b: [] });
    if (j < b.length) bits.push({ kind: "ins", a: [], b: b.slice(j) });
    // Mostly near-misses: one change per word. Otherwise it was reworded as a whole.
    if (near * 2 >= Math.max(a.length, b.length)) out.push(...bits);
    else out.push(op);
  }
  return out;
}

/** Edit distance, with two swapped letters counting as one edit (short words only). */
export function distance(x: string, y: string): number {
  if (Math.abs(x.length - y.length) > 3) return 99;
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i2) => Array.from({ length: y.length + 1 }, (_, j2) => (i2 ? (j2 ? 0 : i2) : j2)));
  for (let i2 = 1; i2 <= x.length; i2++)
    for (let j2 = 1; j2 <= y.length; j2++) {
      const cost = x[i2 - 1] === y[j2 - 1] ? 0 : 1;
      d[i2][j2] = Math.min(d[i2 - 1][j2] + 1, d[i2][j2 - 1] + 1, d[i2 - 1][j2 - 1] + cost);
      if (i2 > 1 && j2 > 1 && x[i2 - 1] === y[j2 - 2] && x[i2 - 2] === y[j2 - 1]) d[i2][j2] = Math.min(d[i2][j2], d[i2 - 2][j2 - 2] + 1);
    }
  return d[x.length][y.length];
}

const isMark = (w: string) => /^[^\p{L}\p{N}]+$/u.test(w);
const close = (x: string, y: string) => x.toLowerCase() === y.toLowerCase() || (x.length > 2 && distance(x.toLowerCase(), y.toLowerCase()) <= 2) || (isMark(x) && isMark(y));
const ARTICLES = new Set(["a", "an", "the"]);
const SMALL = new Set(["to", "of", "in", "on", "at", "for", "is", "are", "was", "were", "be", "it", "i", "and", "that", "with", "as", "by", "has", "have", "had", "will", "can", "do", "does", "did", "not"]);
const words = (ts: Tok[]) => ts.map((t) => t.w).join(" ").replace(/ ([,.;:!?])/g, "$1");
const q = (s: string) => `“${s}”`;

/** A short reason for one change. */
export function explain(op: Op): { label: string; detail: string } {
  const A = words(op.a);
  const B = words(op.b);
  if (op.kind === "ins") {
    if (op.b.every((t) => isMark(t.w))) return { label: "Punctuation", detail: `Added ${q(B)}${B === "," ? " to separate the parts of the sentence" : B === "." ? " to end the sentence" : ""}` };
    if (op.b.length === 1 && ARTICLES.has(B.toLowerCase())) return { label: "Missing word", detail: `Added the article ${q(B)}` };
    if (op.b.length <= 2 && op.b.every((t) => SMALL.has(t.w.toLowerCase()) || ARTICLES.has(t.w.toLowerCase()))) return { label: "Missing word", detail: `Added ${q(B)} so the sentence reads naturally` };
    return { label: "Added", detail: `Added ${q(B)}` };
  }
  if (op.kind === "del") {
    if (op.a.every((t) => isMark(t.w))) return { label: "Punctuation", detail: `Removed the extra ${q(A)}` };
    return { label: "Removed", detail: `Removed ${q(A)}: not needed` };
  }
  // Replacements.
  if (op.a.length === 1 && op.b.length === 1) {
    const x = A;
    const y = B;
    if (x.toLowerCase() === y.toLowerCase()) return { label: "Capital letter", detail: `${q(x)} → ${q(y)}` };
    if (isMark(x) && isMark(y)) return { label: "Punctuation", detail: `${q(x)} → ${q(y)}` };
    const lx = x.toLowerCase();
    const ly = y.toLowerCase();
    if (lx.replace(/['’]/g, "") === ly.replace(/['’]/g, "")) return { label: "Apostrophe", detail: `${q(x)} → ${q(y)}` };
    const shared = (() => {
      let k = 0;
      while (k < lx.length && k < ly.length && lx[k] === ly[k]) k++;
      return k;
    })();
    if (distance(lx, ly) <= 2 && Math.min(lx.length, ly.length) > 3 && shared < Math.min(lx.length, ly.length) - 1) return { label: "Spelling", detail: `${q(x)} → ${q(y)}` };
    if (shared >= 3 && shared >= Math.min(lx.length, ly.length) - 3) return { label: "Word form", detail: `${q(x)} → ${q(y)} (tense, number or form)` };
    if (distance(lx, ly) <= 2 && lx.length > 2) return { label: "Spelling", detail: `${q(x)} → ${q(y)}` };
    return { label: "Better word", detail: `${q(x)} → ${q(y)}` };
  }
  if (op.a.length === op.b.length + 1 && op.b.every((t) => op.a.some((s) => s.w === t.w))) return { label: "Removed", detail: `${q(A)} → ${q(B)}` };
  return { label: op.a.length > 3 || op.b.length > 3 ? "Reworded" : "Clearer wording", detail: `${q(A)} → ${q(B)}` };
}

/** Every change, in reading order, with its reason. */
export function changesOf(ops: Op[]): Change[] {
  const out: Change[] = [];
  ops.forEach((op, k) => {
    if (op.kind === "same") return;
    out.push({ op: k, kind: op.kind, ...explain(op) });
  });
  return out;
}

/** "3 changes: 2 spelling, 1 punctuation". */
export function summary(changes: Change[]): string {
  if (!changes.length) return "No changes";
  const by = new Map<string, number>();
  for (const c of changes) by.set(c.label.toLowerCase(), (by.get(c.label.toLowerCase()) ?? 0) + 1);
  return `${changes.length} change${changes.length === 1 ? "" : "s"}: ${[...by].map(([l, n]) => `${n} ${l}`).join(", ")}`;
}

/** How alike two texts are (shared words over the longer one), 0..1. */
export function likeness(x: string, y: string): number {
  const a = tokens(x.toLowerCase()).map((t) => t.w).filter((w) => !isMark(w));
  const b = tokens(y.toLowerCase()).map((t) => t.w).filter((w) => !isMark(w));
  if (!a.length || !b.length) return 0;
  const left = new Map<string, number>();
  for (const w of a) left.set(w, (left.get(w) ?? 0) + 1);
  let n = 0;
  for (const w of b) {
    const c = left.get(w) ?? 0;
    if (c > 0) (n++, left.set(w, c - 1));
  }
  return n / Math.max(a.length, b.length);
}

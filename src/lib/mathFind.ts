import type { JSONContent } from "@tiptap/react";
import { blockLines } from "./latex";
import { definitionsIn, formatAnswer, namesIn, type Vars } from "./mathEval";
import { workingFor } from "./mathSmart";

/**
 * Math blocks across the notes, for the ✦ assistant: find the formulas written before (⭐ ones
 * first), work one out again with other values, or change the values in the block itself.
 * The same rules as the block (editor/mathBlock.tsx): "r = 3" in a line or a math block above
 * defines r for the blocks below it; the block's last line is the one worked out; hand-turned
 * values are kept in its `tweaks` attr.
 */

export interface FoundFormula {
  /** A day (YYYY-MM-DD) or a page title. */
  note: string;
  /** Where the block is in the note's JSON. */
  path: number[];
  latex: string;
  /** The line worked out ("A = pi*r^2"). */
  target: string;
  lhs: string | null;
  expr: string;
  /** Each variable it uses, with its value (definitions above + hand turns) and what it means. */
  vars: { name: string; value: number | null; label?: string }[];
  answer: string | null;
  steps: string[];
  /** The question it was solved from (🤖 Ask), when it was. */
  question?: string;
  starred?: boolean;
}

const parseJson = <T,>(s: unknown, fallback: T): T => {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const textOf = (n: JSONContent): string => (n.text ?? "") + (n.content ?? []).map(textOf).join("");

/** A block's formula worked out with the lines above it and its own hand turns (and `values` on top). */
export function workOut(above: string[], latex: string, tweaks: Record<string, number> = {}, values: Record<string, number> = {}) {
  const plain = blockLines(latex);
  const target = plain[plain.length - 1] ?? "";
  const defs = definitionsIn([...above, ...plain.slice(0, -1)]);
  const vars: Vars = new Map();
  for (const d of defs) vars.set(d.name, d.value);
  const parts = target.split("=");
  const lhs = parts.length >= 2 && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(parts[0]) ? parts[0].trim() : null;
  const expr = ((lhs ? parts[1] : parts[0]) ?? "").trim();
  const used = namesIn(expr).filter((n) => n !== lhs);
  for (const [k, v] of Object.entries({ ...tweaks, ...values })) if (used.includes(k) && Number.isFinite(v)) vars.set(k, v);
  const w = target ? workingFor(target, vars) : null;
  return {
    target,
    lhs,
    expr,
    vars: used.map((n) => ({ name: n, value: vars.has(n) ? vars.get(n)! : null, label: defs.filter((d) => d.name === n).pop()?.label })),
    answer: w?.answer ?? null,
    steps: w?.steps ?? [],
  };
}

/** Every math block in a note, each worked out with what's above it. */
export function mathBlocksIn(doc: JSONContent | null | undefined, note: string, starred: (expr: string) => boolean = () => false): FoundFormula[] {
  const out: FoundFormula[] = [];
  const above: string[] = [];
  const walk = (n: JSONContent, path: number[]) => {
    if (n.type === "mathBlock") {
      const latex = String(n.attrs?.latex ?? "");
      if (latex.trim()) {
        const w = workOut(above, latex, parseJson<Record<string, number>>(n.attrs?.tweaks, {}));
        const sol = parseJson<{ prompt?: string } | null>(n.attrs?.solution, null);
        out.push({ note, path, latex, ...w, ...(sol?.prompt ? { question: sol.prompt } : {}), starred: starred(w.expr) });
      }
      above.push(...blockLines(latex));
      return;
    }
    if (n.type === "codeBlock") return;
    if (n.type === "paragraph" || n.type === "heading") {
      const t = textOf(n);
      if (t.includes("=")) above.push(t);
      return;
    }
    (n.content ?? []).forEach((c, i) => walk(c, [...path, i]));
  };
  (doc?.content ?? []).forEach((c, i) => walk(c, [i]));
  return out;
}

/** Does the formula match the words asked for (its name, formula, question or variable labels)? */
export function formulaMatches(f: FoundFormula, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const hay = [f.latex, f.target, f.question ?? "", ...f.vars.map((v) => `${v.name} ${v.label ?? ""}`)].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** One line for a list: "⭐ A = pi*r^2 → A = 28.27 (r = 3) · 2026-11-05". */
export function describeFormula(f: FoundFormula, i: number): string {
  const vals = f.vars.map((v) => `${v.name} = ${v.value === null ? "?" : formatAnswer(v.value)}`).join(", ");
  return `${i + 1}. ${f.starred ? "⭐ " : ""}${f.target}${f.answer ? ` → ${f.answer}` : ""}${vals ? ` (${vals})` : ""} · ${f.note}${f.question ? ` · asked: “${f.question.slice(0, 80)}”` : ""}`;
}

/**
 * New values into a math block: a value the block itself defines ("r = 3" as one of its lines) is
 * rewritten there; anything defined above it (or not at all) becomes a hand turn (`tweaks`).
 */
export function setValuesIn(latex: string, tweaksJson: string, values: Record<string, number>): { latex: string; tweaks: string } {
  const lines = latex.split("\n");
  const tweaks = parseJson<Record<string, number>>(tweaksJson, {});
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) continue;
    const re = new RegExp(`^(\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*)(-?[\\d.,]+)(.*)$`);
    const i = lines.slice(0, -1).findIndex((l) => re.test(l));
    if (i >= 0) {
      lines[i] = lines[i].replace(re, (_m, a: string, _v: string, rest: string) => `${a}${formatAnswer(value)}${rest}`);
      delete tweaks[name];
    } else tweaks[name] = value;
  }
  return { latex: lines.join("\n"), tweaks: Object.keys(tweaks).length ? JSON.stringify(tweaks) : "" };
}

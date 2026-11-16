// Item 6 (15 Nov): "✨ Improve" for a rough prompt. Fixes spelling and grammar and fills in the
// missing little words, keeping the meaning, intent and tone, and adding no new requirements.
// {{fields}} are swapped for markers the model must keep, and the answer is refused if any marker
// comes back missing, doubled or changed. Item 12's "Make my prompt" uses the same rules.
import { askAi } from "./client";

export interface Improved {
  text: string;
  /** A short note on what changed and why. */
  note: string;
  /** Words that weren't there before (filled gaps), to check. */
  added: string[];
  /** Who made it, for the event log (e.g. "Gemini"). */
  actor: string;
}

const MARK = (i: number) => `⟦F${i}⟧`;

/** {{fields}} → ⟦F1⟧ markers the model leaves alone. */
export function maskFields(text: string): { masked: string; fields: string[] } {
  const fields: string[] = [];
  const masked = text.replace(/\{\{[^{}]*\}\}/g, (m) => (fields.push(m), MARK(fields.length)));
  return { masked, fields };
}

/** The markers back to {{fields}}; null when any is missing, doubled or new. */
export function unmaskFields(text: string, fields: string[]): string | null {
  const found = [...text.matchAll(/⟦F(\d+)⟧/g)].map((m) => Number(m[1]));
  if (found.length !== fields.length || new Set(found).size !== fields.length || found.some((n) => n < 1 || n > fields.length)) return null;
  if (/\{\{[^{}]*\}\}/.test(text)) return null;
  return text.replace(/⟦F(\d+)⟧/g, (_m, n) => fields[Number(n) - 1]);
}

export const IMPROVE_SYSTEM =
  "You improve a person's rough writing of a prompt for an AI. They know what they want but their grammar is weak and they leave out small words. " +
  "Fix spelling, grammar and punctuation, fill in the missing words so every sentence reads naturally, and split run-on sentences. " +
  "Keep their meaning, intent, tone, language and every detail. Do NOT add new requirements, steps, facts, examples or constraints, and do not remove any. " +
  "Words inside {single curly braces} describe a word the writer couldn't find: replace each with the best word for it. " +
  "Markers like ⟦F1⟧ are fill-in fields: keep each one exactly once, unchanged, where it belongs. " +
  'Reply as JSON: {"improved": the improved text, "note": one short sentence on what you changed, "added": the words you added that were not in the original}.';

const SCHEMA = {
  type: "object",
  properties: {
    improved: { type: "string" },
    note: { type: "string" },
    added: { type: "array", items: { type: "string" } },
  },
  required: ["improved", "note", "added"],
};

type Ask = typeof askAi;

/** The improved prompt (throws with a plain message when it can't be used). */
export async function improvePrompt(text: string, opts: { system?: string; model?: string; ask?: Ask; task?: "grammar" | "organise"; provider?: "gemini" } = {}): Promise<Improved> {
  const { masked, fields } = maskFields(text);
  const ask = opts.ask ?? askAi;
  const answer = await ask<{ improved: string; note: string; added: string[] }>({
    task: opts.task ?? "grammar",
    ...(opts.provider ? { provider: opts.provider, cloud: true } : {}),
    system: opts.system ?? IMPROVE_SYSTEM,
    text: masked,
    schema: SCHEMA,
    maxTokens: 2000,
    model: opts.model,
  });
  const data = (answer.json as { improved?: string; note?: string; added?: string[] } | undefined) ?? parseLoose(answer.text);
  const improved = data?.improved?.trim();
  if (!improved) throw new Error("The AI didn't send an improved version. Try again.");
  const back = unmaskFields(improved, fields);
  if (back === null) throw new Error("The AI changed a {{field}}, so its version wasn't used. Try again.");
  return { text: back, note: (data?.note ?? "").trim(), added: (data?.added ?? []).filter((w) => typeof w === "string" && w.trim()), actor: answer.actor };
}

function parseLoose(text: string): { improved?: string; note?: string; added?: string[] } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

export type DiffPart = { text: string; kind: "same" | "new" };

/** The improved text in pieces, the words not in the original marked "new" (an LCS over words). */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/).filter((w) => w && !/^\s+$/.test(w));
  const tokens = after.split(/(\s+)/).filter(Boolean);
  const b = tokens.filter((w) => !/^\s+$/.test(w));
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}{}⟦⟧]/gu, "");
  // Long texts: skip the table (it's n×m) and only mark words that appear nowhere before.
  const keep = new Set<number>();
  if (a.length * b.length <= 400_000) {
    const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--) L[i][j] = norm(a[i]) === norm(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (norm(a[i]) === norm(b[j])) (keep.add(j), i++, j++);
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
  } else {
    const seen = new Set(a.map(norm));
    b.forEach((w, j) => seen.has(norm(w)) && keep.add(j));
  }
  const out: DiffPart[] = [];
  let j = 0;
  for (const t of tokens) {
    const kind: DiffPart["kind"] = /^\s+$/.test(t) ? "same" : keep.has(j++) ? "same" : "new";
    const last = out[out.length - 1];
    if (last && (last.kind === kind || /^\s+$/.test(t))) last.text += t;
    else out.push({ text: t, kind });
  }
  return out;
}

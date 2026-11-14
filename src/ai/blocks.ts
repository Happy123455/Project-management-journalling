import type { JSONContent } from "@tiptap/react";
import { LID, randomLid, siblingIds } from "../sync/lineIds";
import { textBlocks } from "../lib/append";
import { docText } from "../lib/words";

/**
 * A note as numbered top-level blocks, for the AI: it reads a compact map and edits a block by its
 * number. A section (the blocks the person picked) limits what it may change; that's enforced
 * here, not left to the model.
 */

export interface Target {
  day?: string;
  title?: string;
}

export interface Section extends Target {
  /** Line ids of the picked top-level blocks. */
  ids: string[];
  /** Shown in the chat, e.g. "Today · Plans → Gym". */
  label: string;
}

export interface BlockRow {
  id: string;
  type: string;
  text: string;
}

/** The top-level blocks with their line ids (made from content where a block has none yet). */
export function blockRows(doc: JSONContent | null): BlockRow[] {
  const nodes = doc?.content ?? [];
  const ids = siblingIds(nodes);
  return nodes.map((n, i) => ({ id: ids[i], type: n.type ?? "paragraph", text: docText(n).trim() }));
}

const prefix = (r: BlockRow) => (r.type === "heading" ? "# " : r.type === "bulletList" || r.type === "taskList" ? "(list) " : r.type === "codeBlock" ? "(code) " : "");

/** The blocks as "[n] text" lines (only the section's blocks when one is given). */
export function numbered(doc: JSONContent | null, section?: Section | null): string {
  const rows = blockRows(doc);
  const shown = section ? rows.filter((r) => section.ids.includes(r.id)) : rows;
  if (!shown.length) return "(no blocks)";
  return shown.map((r, i) => `[${i + 1}] ${prefix(r)}${r.text.replace(/\n/g, " / ").slice(0, 1200) || "(empty)"}`).join("\n");
}

/** Text from the model as blocks: "# " / "## " lines become headings, the rest paragraphs. */
export function toBlocks(text: string): JSONContent[] {
  return text.split("\n").flatMap((line) => {
    const h = /^(#{1,3})\s+(.*\S)/.exec(line.trim());
    return h ? [{ type: "heading", attrs: { level: h[1].length }, content: [{ type: "text", text: h[2] }] }] : textBlocks(line);
  });
}

export type BlockOp = { op: "replace"; n: number; text: string } | { op: "insert_after"; n: number; text: string } | { op: "delete"; n: number };

/**
 * The note with one block operation done. `n` counts the blocks shown to the model (the
 * section's, when there is one; 0 = before the first for insert_after). New blocks join the section.
 */
export function applyBlockOp(doc: JSONContent | null, op: BlockOp, section?: Section | null): { doc: JSONContent; section?: Section | null } | string {
  const nodes = [...(doc?.content ?? [])];
  const rows = blockRows(doc);
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !section || section.ids.includes(r.id));
  const fresh = (text: string): JSONContent[] => toBlocks(text).map((b) => ({ ...b, attrs: { ...(b.attrs ?? {}), [LID]: randomLid() } }));
  let ids = section?.ids ?? [];
  if (op.op === "insert_after") {
    if (op.n < 0 || op.n > visible.length) return `Block ${op.n} doesn't exist (there are ${visible.length}).`;
    // Before the first shown block, or after block n.
    const at = op.n === 0 ? (visible[0]?.i ?? nodes.length) : visible[op.n - 1].i + 1;
    const added = fresh(op.text);
    nodes.splice(at, 0, ...added);
    ids = [...ids, ...added.map((b) => b.attrs?.[LID] as string)];
  } else {
    const hit = visible[op.n - 1];
    if (!hit) return `Block ${op.n} doesn't exist${section ? " in the section" : ""} (there are ${visible.length}).`;
    // Keep ids on the existing blocks so the section (and sync) still know them.
    const own = (nodes[hit.i].attrs?.[LID] as string) || hit.r.id;
    if (op.op === "delete") {
      nodes.splice(hit.i, 1);
      ids = ids.filter((x) => x !== own);
    } else {
      const added = fresh(op.text);
      if (!added.length) return "text is empty";
      added[0] = { ...added[0], attrs: { ...added[0].attrs, [LID]: own } };
      // A heading stays a heading when it's replaced by one line.
      if (nodes[hit.i].type === "heading" && added.length === 1 && added[0].type === "paragraph") added[0] = { ...nodes[hit.i], attrs: { ...nodes[hit.i].attrs, [LID]: own }, content: added[0].content };
      nodes.splice(hit.i, 1, ...added);
      ids = [...ids, ...added.slice(1).map((b) => b.attrs?.[LID] as string)];
    }
  }
  return { doc: { type: "doc", ...(doc ?? {}), content: nodes }, section: section ? { ...section, ids } : section };
}

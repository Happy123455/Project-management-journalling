// Item 13: the assistant's edits on a note's saved JSON (no editor needed): finding open tasks,
// putting a copy of something under a heading or a box line, ticking a task. Copies never carry
// the original's line id or line stamp, so sync sees them as new lines.
import type { JSONContent } from "@tiptap/core";
import { extractTasks } from "../lib/projects";
import { docText } from "../lib/words";
import { LID } from "../sync/lineIds";
import { ED } from "../sync/lineStamps";

export interface FoundTask {
  /** Where it is: a day (YYYY-MM-DD) or a page title. */
  note: string;
  text: string;
  checked: boolean;
  path: number[];
}

export const tasksIn = (note: string, doc: JSONContent | null | undefined): FoundTask[] => (doc ? extractTasks(doc).map((t) => ({ note, ...t })) : []);

export function nodeAt(doc: JSONContent, path: number[]): JSONContent | null {
  let n: JSONContent | undefined = doc;
  for (const i of path) n = n?.content?.[i];
  return n ?? null;
}

/** A copy without line ids or stamps (they'd make sync treat it as the same line). */
export function freshCopy(node: JSONContent): JSONContent {
  const attrs = node.attrs ? Object.fromEntries(Object.entries(node.attrs).filter(([k]) => k !== LID && k !== ED)) : undefined;
  return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map(freshCopy) } : {}) };
}

/** A task item as a block on its own (a task list with that one item, its sub-items kept). */
export function taskBlock(item: JSONContent, checked = false): JSONContent {
  const copy = freshCopy(item);
  return { type: "taskList", content: [{ ...copy, attrs: { ...(copy.attrs ?? {}), checked } }] };
}

const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/\[\[|\]\]|[#*_`>:]/g, "")
    .replace(/[\p{Extended_Pictographic}️]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const indentOf = (n: JSONContent) => Number(n.attrs?.indent ?? 0);

/**
 * The document with `blocks` added at the end of the section a top-level line names: a heading
 * (up to the next heading as big or bigger) or a box line (the lines indented under it, where the
 * new ones go one level in). The label matches the line's text, ignoring case, #, [[ ]] and emoji;
 * an exact match is preferred to one that starts with it. No such line: it's added at the end,
 * with the blocks under it. `found` says which happened.
 */
export function insertUnder(doc: JSONContent | null, label: string, blocks: JSONContent[]): { doc: JSONContent; found: boolean } {
  const content = [...(doc?.content ?? [])];
  const want = plain(label);
  const texts = content.map((b) => plain(docText(b)));
  let at = texts.findIndex((t) => t === want);
  if (at < 0) at = texts.findIndex((t) => !!want && t.startsWith(want) && t.length <= want.length + 24);
  if (at < 0) {
    // Reuse a blank last line, then the label as a heading and the blocks under it.
    while (content.length && content[content.length - 1].type === "paragraph" && !content[content.length - 1].content?.length) content.pop();
    const heading = { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: label.trim() }] };
    return { doc: { type: "doc", ...(doc ?? {}), content: [...content, heading, ...blocks] }, found: false };
  }
  const head = content[at];
  let end = at + 1;
  let put = blocks;
  if (head.type === "heading") {
    const level = Number(head.attrs?.level ?? 1);
    while (end < content.length && !(content[end].type === "heading" && Number(content[end].attrs?.level ?? 1) <= level)) end++;
  } else {
    const base = indentOf(head);
    while (end < content.length && indentOf(content[end]) > base) end++;
    put = blocks.map((b) => ({ ...b, attrs: { ...(b.attrs ?? {}), indent: Math.min(8, base + 1 + indentOf(b)) } }));
  }
  // Blank lines at the end of the section stay after what's added.
  let slot = end;
  while (slot > at + 1 && content[slot - 1].type === "paragraph" && !content[slot - 1].content?.length) slot--;
  content.splice(slot, 0, ...put);
  return { doc: { ...(doc ?? { type: "doc" }), content }, found: true };
}

/** The document with the first open task containing `text` ticked (or unticked), or null. */
export function tickTask(doc: JSONContent, text: string, done = true): { doc: JSONContent; task: string } | null {
  const want = plain(text);
  const t = extractTasks(doc).find((x) => x.checked !== done && plain(x.text).includes(want));
  if (!t) return null;
  const set = (node: JSONContent, path: number[]): JSONContent => {
    if (!path.length) return { ...node, attrs: { ...(node.attrs ?? {}), checked: done } };
    const [i, ...rest] = path;
    const content = [...(node.content ?? [])];
    content[i] = set(content[i], rest);
    return { ...node, content };
  };
  return { doc: set(doc, t.path), task: t.text };
}

/** Paragraphs from lines of text ("- [ ] x" lines become tasks). */
export function linesToBlocks(text: string): JSONContent[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1))
    .map((line) => {
      const task = line.match(/^\s*[-*]\s*\[( |x)\]\s*(.*)$/i);
      if (task) return { type: "taskList", content: [{ type: "taskItem", attrs: { checked: task[1].toLowerCase() === "x" }, content: [{ type: "paragraph", content: task[2] ? [{ type: "text", text: task[2] }] : [] }] }] };
      const t = line.trim();
      return { type: "paragraph", content: t ? [{ type: "text", text: t }] : [] };
    });
}

/** A count of things as rows for a table, biggest first. */
export function topCounts(items: string[], limit = 10): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) if (i) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

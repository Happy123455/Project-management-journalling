import type { Editor, JSONContent } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { LineEdit } from "../lib/reminders";
import { BOX_TITLE } from "../lib/routine";

/**
 * Small changes to a day's note made from outside the editor (a routine tap, a reminder ticked off
 * or moved to a new time). When the day is open, the change goes through its editor (so it's saved,
 * synced and undoable like typing); otherwise the stored note is changed.
 */

const open = new Map<string, Editor>();

/** JournalEditor registers itself under its live key ("day:2026-11-04") while it's showing. */
export function registerOpenNote(key: string, editor: Editor): () => void {
  open.set(key, editor);
  return () => {
    if (open.get(key) === editor) open.delete(key);
  };
}

/** The open editor of a day, or null (not open, or in Source mode, where the text box is the truth). */
export function openDayEditor(day: string): Editor | null {
  const e = open.get(`day:${day}`);
  if (!e || e.isDestroyed) return null;
  if (document.querySelector(".editor.mode-source")) return null;
  return e;
}

/** A line's text as reminders see it: its text pieces joined (media and breaks left out). */
const jsonLine = (n: JSONContent) => (n.content ?? []).map((c) => c.text ?? "").join("");

/** Applies a line edit to a text node list, keeping each piece's marks. */
function spliceText(content: JSONContent[], edit: LineEdit): JSONContent[] {
  const out: JSONContent[] = [];
  let at = 0;
  let inserted = false;
  const put = (text: string, like?: JSONContent) => {
    if (!text) return;
    out.push(like?.marks ? { type: "text", text, marks: like.marks } : { type: "text", text });
  };
  for (const c of content) {
    if (c.type !== "text" || !c.text) {
      if (!inserted && at >= edit.index) {
        put(edit.ins);
        inserted = true;
      }
      out.push(c);
      continue;
    }
    const a = at;
    const b = at + c.text.length;
    at = b;
    const from = Math.max(edit.index, a);
    const to = Math.min(edit.index + edit.del, b);
    if (edit.index > b || (edit.index === b && edit.del > 0)) {
      out.push(c);
      continue;
    }
    put(c.text.slice(0, Math.max(0, from - a)), c);
    if (!inserted) {
      put(edit.ins, c);
      inserted = true;
    }
    put(c.text.slice(Math.max(0, to - a)), c);
  }
  if (!inserted) put(edit.ins);
  return out;
}

/** The note with the first line reading `line` changed by `edit`, or null when no line reads so. */
export function editLineJSON(doc: JSONContent, line: string, edit: LineEdit): JSONContent | null {
  let done = false;
  const walk = (n: JSONContent): JSONContent => {
    if (done) return n;
    if ((n.type === "paragraph" || n.type === "heading") && jsonLine(n) === line) {
      done = true;
      return { ...n, content: spliceText(n.content ?? [], edit) };
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  const next = walk(doc);
  return done ? next : null;
}

/** Text position of character `index` of a textblock's text pieces (non-text nodes skipped). */
function posOf(block: PMNode, blockPos: number, index: number): number {
  let at = 0;
  let pos = blockPos + 1;
  let found = -1;
  block.forEach((child, offset) => {
    if (found >= 0 || !child.isText) return;
    const len = child.text!.length;
    if (index <= at + len) found = blockPos + 1 + offset + (index - at);
    at += len;
    pos = blockPos + 1 + offset + child.nodeSize;
  });
  return found >= 0 ? found : pos;
}

/** Same as editLineJSON, through an open editor. False when no line reads so. */
export function editLinePM(editor: Editor, line: string, edit: LineEdit): boolean {
  let hit: { node: PMNode; pos: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.isTextblock) {
      if ((node.type.name === "paragraph" || node.type.name === "heading") && node.content.content.filter((c) => c.isText).map((c) => c.text).join("") === line) hit = { node, pos };
      return false;
    }
    return true;
  });
  if (!hit) return false;
  const { node, pos } = hit as { node: PMNode; pos: number };
  const from = posOf(node, pos, edit.index);
  const to = edit.del ? posOf(node, pos, edit.index + edit.del) : from;
  const tr = editor.state.tr;
  if (edit.ins) tr.insertText(edit.ins, from, to);
  else tr.delete(from, to);
  editor.view.dispatch(tr);
  return true;
}

/** Adds a log line at the end of the note's [[Routine]] box (made at the end if missing), through an open editor. */
export function insertLogLinePM(editor: Editor, line: string) {
  const { doc } = editor.state;
  let title = -1;
  for (let i = 0; i < doc.childCount; i++) {
    const n = doc.child(i);
    if (n.type.name === "paragraph" && n.textContent.trim().toLowerCase() === BOX_TITLE.toLowerCase()) {
      title = i;
      break;
    }
  }
  const para = (text: string, indent: number) => editor.schema.nodes.paragraph.create(indent ? { indent } : null, editor.schema.text(text));
  const tr = editor.state.tr;
  if (title >= 0) {
    const base = Number(doc.child(title).attrs.indent ?? 0);
    let end = title + 1;
    while (end < doc.childCount && Number(doc.child(end).attrs.indent ?? 0) > base) end++;
    let pos = 0;
    for (let i = 0; i < end; i++) pos += doc.child(i).nodeSize;
    tr.insert(pos, para(line, base + 1));
    // A folded box opens, so the new line is seen.
    if (doc.child(title).attrs.collapsed) {
      let tp = 0;
      for (let i = 0; i < title; i++) tp += doc.child(i).nodeSize;
      tr.setNodeAttribute(tp, "collapsed", false);
    }
  } else {
    const last = doc.lastChild;
    const blank = last && last.type.name === "paragraph" && last.content.size === 0 && !last.attrs.info;
    const at = blank ? doc.content.size - last!.nodeSize : doc.content.size;
    tr.replaceWith(at, doc.content.size, [para(BOX_TITLE, 0), para(line, 1)]);
  }
  editor.view.dispatch(tr);
}

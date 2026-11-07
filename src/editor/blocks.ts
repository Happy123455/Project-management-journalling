import { plainText } from "../lib/plainText";
import { Extension } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection, type Command, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { Mapping, ReplaceAroundStep } from "@tiptap/pm/transform";
import type { JSONContent } from "@tiptap/core";
import { docToMarkdown } from "../lib/source";

/**
 * The block system. Every top-level node of a note is a block. Nesting is an `indent` level on the
 * block (lists also nest their own items): a block's children are the blocks right after it that are
 * indented deeper, so moving, collapsing, duplicating or deleting a block takes its children along.
 * The ⋮⋮ handle and its menu are in BlockHandle.tsx; this file has the commands and keys.
 */

export const BLOCK_TYPES = [
  "paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock",
  "horizontalRule", "attachmentFile", "linkCard", "promptBlock", "mathBlock",
];
export const MAX_INDENT = 8;

export const indentOf = (node: PMNode) => (node.attrs.indent as number | undefined) ?? 0;

/** Index of the top-level block holding `pos`. */
export function blockIndexAt(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  return Math.min($pos.index(0), doc.childCount - 1);
}

/** Start position of top-level block `index` (or the end of the note for index = childCount). */
export function blockPos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index && i < doc.childCount; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/** The block at `index` with its children: indexes [start, end) and positions [from, to). */
export function blockRange(doc: PMNode, index: number) {
  let end = index + 1;
  while (end < doc.childCount && indentOf(doc.child(end)) > indentOf(doc.child(index))) end++;
  return { start: index, end, from: blockPos(doc, index), to: blockPos(doc, end) };
}

/** A [[Project]]-style line with lines nested under it: drawn as a box. */
const isBoxHead = (doc: PMNode, i: number) => {
  const n = doc.child(i);
  return n.isTextblock && /\[\[[^\]]+\]\]/.test(n.textContent) && i + 1 < doc.childCount && indentOf(doc.child(i + 1)) > indentOf(n);
};
/** Blocks a heading's text stops at: a divider, a prompt block, a box (code under a heading is its text). */
const STOPS_HEADING = new Set(["horizontalRule", "promptBlock"]);

/**
 * What folding the block at `index` hides: its nested blocks, and for a heading (like Obsidian)
 * everything under it up to the next heading of the same or a higher level, a divider, or another
 * block (a code block, prompt or box). Moving, copying and deleting still use blockRange.
 */
export function foldRange(doc: PMNode, index: number) {
  const node = doc.child(index);
  const own = blockRange(doc, index);
  if (node.type.name !== "heading") return own;
  const level = Number(node.attrs.level ?? 1);
  const base = indentOf(node);
  let end = own.end;
  while (end < doc.childCount) {
    const n = doc.child(end);
    if (indentOf(n) < base) break;
    if (indentOf(n) === base) {
      if (n.type.name === "heading" && Number(n.attrs.level ?? 1) <= level) break;
      if (STOPS_HEADING.has(n.type.name) || isBoxHead(doc, end)) break;
    }
    end = blockRange(doc, end).end;
  }
  return { start: index, end, from: own.from, to: blockPos(doc, end) };
}

const selectedIndex = (state: EditorState) => blockIndexAt(state.doc, state.selection.from);

/** Changes the indent of the block at `index` (and its children) by `delta`. */
export function indentBlock(index: number, delta: 1 | -1): Command {
  return (state, dispatch) => {
    const { doc } = state;
    const block = doc.child(index);
    if (block.type.spec.attrs?.indent === undefined) return false;
    const level = indentOf(block);
    if (delta > 0 && (index === 0 || level > indentOf(doc.child(index - 1)) || level >= MAX_INDENT)) return false;
    if (delta < 0 && level === 0) return false;
    if (dispatch) {
      const range = blockRange(doc, index);
      const tr = state.tr;
      let pos = range.from;
      for (let i = range.start; i < range.end; i++) {
        const child = doc.child(i);
        if (child.type.spec.attrs?.indent !== undefined) {
          tr.setNodeMarkup(pos, undefined, { ...child.attrs, indent: Math.max(0, Math.min(MAX_INDENT, indentOf(child) + delta)) });
        }
        pos += child.nodeSize;
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Moves the block at `index` (with its children) so it starts at top-level index `target`. */
export function moveBlockTo(index: number, target: number): Command {
  return (state, dispatch) => {
    const { doc } = state;
    const range = blockRange(doc, index);
    if (target >= range.start && target <= range.end) return false;
    if (dispatch) {
      const slice = doc.slice(range.from, range.to).content;
      const tr = state.tr;
      const offset = state.selection.from - range.from;
      const keepsSelection = state.selection.from >= range.from && state.selection.from < range.to;
      tr.delete(range.from, range.to);
      const insertAt = tr.mapping.map(blockPos(doc, target), target > index ? -1 : 1);
      tr.insert(insertAt, slice);
      // Not deeper than one level under the block it now follows.
      const before = insertAt > 0 ? tr.doc.resolve(insertAt).nodeBefore : null;
      const allowed = before ? indentOf(before) + 1 : 0;
      const shift = Math.min(0, allowed - indentOf(slice.firstChild!));
      if (shift) {
        let pos = insertAt;
        slice.forEach((child) => {
          if (child.type.spec.attrs?.indent !== undefined) tr.setNodeMarkup(pos, undefined, { ...child.attrs, indent: Math.max(0, indentOf(child) + shift) });
          pos += child.nodeSize;
        });
      }
      if (keepsSelection) tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + offset, tr.doc.content.size))));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Moves the block at `index` above the previous block, or below the next one (each with its children). */
export function moveBlock(index: number, dir: -1 | 1): Command {
  return (state, dispatch) => {
    const { doc } = state;
    const level = indentOf(doc.child(index));
    if (dir < 0) {
      let k = index - 1;
      while (k > 0 && indentOf(doc.child(k)) > level) k--;
      return k >= 0 && moveBlockTo(index, k)(state, dispatch);
    }
    const next = blockRange(doc, index).end;
    if (next >= doc.childCount) return false;
    return moveBlockTo(index, blockRange(doc, next).end)(state, dispatch);
  };
}

export function duplicateBlock(index: number): Command {
  return (state, dispatch) => {
    const range = blockRange(state.doc, index);
    if (dispatch) dispatch(state.tr.insert(range.to, state.doc.slice(range.from, range.to).content).scrollIntoView());
    return true;
  };
}

/** Deletes the block and its children; an empty note keeps one empty line. */
export function deleteBlock(index: number): Command {
  return (state, dispatch) => {
    const range = blockRange(state.doc, index);
    if (dispatch) {
      const tr = state.tr.delete(range.from, range.to);
      if (!tr.doc.childCount) tr.insert(0, state.schema.nodes.paragraph.create());
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(range.from, tr.doc.content.size))));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Adds an empty line above or below the block (and its children): the way past cards and other non-text blocks. */
export function insertLine(index: number, where: "above" | "below"): Command {
  return (state, dispatch) => {
    const range = blockRange(state.doc, index);
    const pos = where === "above" ? range.from : range.to;
    if (dispatch) {
      const line = state.schema.nodes.paragraph.create({ indent: indentOf(state.doc.child(index)) });
      const tr = state.tr.insert(pos, line);
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function toggleCollapsed(index: number): Command {
  return (state, dispatch) => {
    const node = state.doc.child(index);
    if (foldRange(state.doc, index).end === index + 1 || node.type.spec.attrs?.collapsed === undefined) return false;
    if (dispatch) dispatch(state.tr.setNodeMarkup(blockPos(state.doc, index), undefined, { ...node.attrs, collapsed: !node.attrs.collapsed }));
    return true;
  };
}

/** Collapsed blocks hide their children; blocks with children are marked for the handle and CSS. */
declare global {
  interface Window {
    /** This day's "Day N" for a project (App.tsx), or null when the title isn't a project. */
    __journalDayNumber?: (title: string) => Promise<number | null>;
  }
}

/** "Day N" on a project box's title row; tap to type another number (saved as the line's Day info). */
function dayChip(view: EditorView, title: string, info: Record<string, string> | null): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "block-day-chip";
  chip.hidden = true;
  chip.addEventListener("mousedown", (e) => e.preventDefault());
  // A number set by hand shows at once (it may not be saved yet); otherwise it's worked out from the project.
  const own = Object.entries(info ?? {}).find(([k]) => k.trim().toLowerCase() === "day")?.[1];
  void (own && /^\d+$/.test(own) ? Promise.resolve(Number(own)) : (window.__journalDayNumber?.(title) ?? Promise.resolve(null))).then((n) => {
    if (n === null) return;
    chip.textContent = `Day ${n}`;
    chip.hidden = false;
  });
  chip.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.className = "block-day-input";
    input.value = chip.textContent?.replace(/\D/g, "") ?? "";
    const save = () => {
      const n = Number(input.value);
      input.replaceWith(chip);
      if (!Number.isInteger(n) || n < 1) return;
      const index = blockIndexAt(view.state.doc, view.posAtDOM(chip, 0));
      const block = view.state.doc.child(index);
      view.dispatch(view.state.tr.setNodeMarkup(blockPos(view.state.doc, index), undefined, { ...block.attrs, info: { ...(info ?? {}), Day: String(n) } }));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") input.replaceWith(chip);
    });
    input.addEventListener("blur", save, { once: true });
    chip.replaceWith(input);
    input.focus();
    input.select();
  });
  return chip;
}

function foldButton(collapsed: boolean, className: string, onClick: () => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.contentEditable = "false";
  button.textContent = collapsed ? "▸" : "▾";
  button.setAttribute("aria-label", collapsed ? "Unfold" : "Fold");
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return button;
}

/** The last text line inside a block (the block itself when it's one), with its position. */
function lastTextblock(node: PMNode, pos: number): { node: PMNode; pos: number } | null {
  if (node.isTextblock) return { node, pos };
  let found: { node: PMNode; pos: number } | null = null;
  node.descendants((child, at) => {
    if (child.isTextblock) found = { node: child, pos: pos + 1 + at };
    return !child.isTextblock;
  });
  return found;
}

function copyButton(onCopy: () => Promise<void>): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "block-copy";
  button.contentEditable = "false";
  button.textContent = "⧉";
  button.title = "Copy this block";
  button.setAttribute("aria-label", "Copy this block");
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onCopy().then(
      () => {
        button.textContent = "✓";
        button.classList.add("copied");
        window.setTimeout(() => {
          button.textContent = "⧉";
          button.classList.remove("copied");
        }, 1400);
      },
      () => {},
    );
  });
  return button;
}

/** The block at `index` with everything nested in it, as text (Markdown-like, nesting as tabs). */
export function blockText(doc: PMNode, index: number): string {
  // A heading takes the text under it, like folding does.
  const range = foldRange(doc, index);
  const base = indentOf(doc.child(index));
  const content: JSONContent[] = [];
  for (let i = range.start; i < range.end; i++) {
    const json = doc.child(i).toJSON() as JSONContent;
    if (json.attrs?.indent) json.attrs = { ...json.attrs, indent: Math.max(0, json.attrs.indent - base) };
    if (json.attrs?.collapsed) json.attrs = { ...json.attrs, collapsed: false };
    content.push(json);
  }
  return docToMarkdown({ type: "doc", content });
}

/**
 * What ⧉ copies: the block and what's under it as plain text: no [[box title]] line, no markup,
 * no <br/> for empty lines (Hapi pastes it into other apps).
 */
export function blockPlainText(doc: PMNode, index: number): string {
  const range = foldRange(doc, index);
  const base = indentOf(doc.child(index));
  const content: JSONContent[] = [];
  for (let i = range.start; i < range.end; i++) {
    const json = doc.child(i).toJSON() as JSONContent;
    if (json.attrs?.indent) json.attrs = { ...json.attrs, indent: Math.max(0, json.attrs.indent - base) };
    content.push(json);
  }
  return plainText(content, { dropBoxTitle: true });
}

async function copyBlock(view: EditorView, index: number) {
  const { copyText } = await import("./codeBlock");
  await copyText(blockPlainText(view.state.doc, index));
}

export function blockDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  // The view, handed over by the first widget drawn (decorations are built without one).
  let view0: EditorView | null = null;
  let hiddenUntil = -1;
  // A [[Project]] / [[Person]] / [[Log]] line with lines nested under it is drawn as one box.
  let boxUntil = -1;
  // Lines inside a block that already has its own ⧉ (top and bottom): no third one for a list in it.
  let copiedUntil = -1;
  let pos = 0;
  /** Last lines that carry a block's bottom tools: position → size (they become position: relative). */
  const bottomHosts = new Map<number, number>();
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    const range = foldRange(doc, i);
    const classes: string[] = [];
    const attrs: Record<string, string> = {};
    if (i < boxUntil) classes.push(i === boxUntil - 1 ? "block-box-body block-box-end" : "block-box-body");
    if (i < hiddenUntil) classes.push("block-hidden");
    else if (range.end > i + 1) {
      classes.push(node.attrs.collapsed ? "block-parent block-collapsed" : "block-parent");
      if (node.attrs.collapsed) {
        attrs["data-hidden-count"] = String(range.end - i - 1);
        hiddenUntil = range.end;
      }
      const index = i;
      const fold = () => toggleCollapsed(index)(view0!.state, view0!.dispatch);
      if (node.type.name === "heading") {
        // Headings fold like Obsidian's: a ▾ before the heading folds the text under it.
        decos.push(
          Decoration.widget(pos + 1, (view) => {
            view0 = view;
            return foldButton(node.attrs.collapsed, "block-heading-fold", fold);
          }, { side: -1, key: `hfold-${i}-${node.attrs.collapsed}`, ignoreSelection: true }),
        );
      }
      const isBox = node.isTextblock && /\[\[[^\]]+\]\]/.test(node.textContent);
      // Any block with lines under it gets them (it used to take four lines or more, so most bulleted
      // or formatted blocks never showed a ⧉).
      if (!node.attrs.collapsed && (range.end - i > 1 || isBox)) {
        copiedUntil = Math.max(copiedUntil, range.end);
        // Copy and fold at the bottom right, on the block's lower edge (away from the line being
        // typed, so a tap at the end of the text doesn't hit them).
        const last = doc.child(range.end - 1);
        const lastPos = blockPos(doc, range.end - 1);
        // Not inside a code block's text: there the ⧉ ▴ became part of the code's lines.
        const found = lastTextblock(last, lastPos);
        const inner = found && found.node.type.name !== "codeBlock" ? found : null;
        const at = inner ? inner.pos + inner.node.nodeSize - 1 : blockPos(doc, range.end);
        if (inner) bottomHosts.set(inner.pos, inner.node.nodeSize);
        decos.push(
          Decoration.widget(at, (view) => {
            view0 = view;
            const row = document.createElement("span");
            row.className = inner ? "block-bottom-tools" : "block-bottom-tools inline";
            row.contentEditable = "false";
            row.append(copyButton(() => copyBlock(view, index)));
            if (range.end - i > 1) {
              const b = foldButton(false, "block-bottom-fold", fold);
              b.textContent = "▴";
              b.title = "Fold this block";
              row.append(b);
            }
            return row;
          }, { side: 1, key: `bfold-${i}-${range.end}`, ignoreSelection: true, stopEvent: () => true }),
        );
      }
      if (node.isTextblock && /\[\[[^\]]+\]\]/.test(node.textContent)) {
        // A box nested inside another box keeps the outer box's look but gets its own Day chip.
        if (i >= boxUntil) {
          classes.push(node.attrs.collapsed ? "block-box-head block-box-end" : "block-box-head");
          boxUntil = range.end;
        } else classes.push("block-box-subhead");
        // The fold button on the title row.
        decos.push(
          Decoration.widget(pos + node.nodeSize - 1, (view) => {
            const row = document.createElement("span");
            row.className = "block-box-tools";
            row.contentEditable = "false";
            const title = /\[\[([^\]|]+)/.exec(node.textContent)?.[1]?.trim();
            if (title) row.append(dayChip(view, title, node.attrs.info as Record<string, string> | null));
            if (!node.attrs.collapsed) row.append(copyButton(() => copyBlock(view, index)));
            const button = document.createElement("button");
            button.type = "button";
            button.className = "block-box-fold";
            button.contentEditable = "false";
            button.textContent = node.attrs.collapsed ? "▸" : "▾";
            button.setAttribute("aria-label", node.attrs.collapsed ? "Unfold" : "Fold");
            button.addEventListener("mousedown", (e) => e.preventDefault());
            button.addEventListener("click", () => toggleCollapsed(index)(view.state, view.dispatch));
            row.append(button);
            return row;
          }, { side: 1, key: `fold-${i}-${node.attrs.collapsed}-${JSON.stringify(node.attrs.info)}`, ignoreSelection: true }),
        );
      }
    }
    else if (LISTS.has(node.type.name) && i >= hiddenUntil && i >= copiedUntil && i >= boxUntil && (node.childCount > 1 || node.firstChild?.childCount !== 1)) {
      // A bulleted / numbered / task list is one block holding all its points: ⧉ on its last line.
      const inner = lastTextblock(node, pos);
      if (inner && inner.node.type.name !== "codeBlock") {
        const index = i;
        bottomHosts.set(inner.pos, inner.node.nodeSize);
        decos.push(
          Decoration.widget(inner.pos + inner.node.nodeSize - 1, (view) => {
            view0 = view;
            const row = document.createElement("span");
            row.className = "block-bottom-tools";
            row.contentEditable = "false";
            row.append(copyButton(() => copyBlock(view, index)));
            return row;
          }, { side: 1, key: `lcopy-${i}-${node.nodeSize}`, ignoreSelection: true, stopEvent: () => true }),
        );
      }
    }
    if (classes.length) decos.push(Decoration.node(pos, pos + node.nodeSize, { ...attrs, class: classes.join(" ") }));
    pos += node.nodeSize;
  }
  for (const [at, size] of bottomHosts) decos.push(Decoration.node(at, at + size, { class: "block-bottom-host" }));
  return DecorationSet.create(doc, decos);
}

const blocksKey = new PluginKey("blocks");

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

/**
 * Turning a nested line into a list (the bullet button, "- ", "1. ", "[ ] ") wraps it in a new
 * top-level list, which would start at no indent and fall out of the box it was in. The list
 * takes the line's indent instead, so it stays nested where the line was.
 */
export function listKeepsIndent(state: EditorState, before?: EditorState, trs: readonly Transaction[] = []): Transaction | null {
  let tr: Transaction | null = null;
  // Back to where each line was before: a line just lifted out of a nested list keeps its nesting.
  const back = new Mapping();
  for (const t of trs) back.appendMapping(t.mapping);
  const undo = back.invert();
  state.doc.forEach((node, offset) => {
    if (before && node.isTextblock && !indentOf(node) && node.type.spec.attrs?.indent !== undefined) {
      const old = undo.map(offset + 1, 1);
      if (old > 0 && old < before.doc.content.size) {
        const $old = before.doc.resolve(old);
        const was = $old.depth >= 2 ? $old.node(1) : null;
        if (was && LISTS.has(was.type.name) && indentOf(was)) {
          tr ??= state.tr;
          tr.setNodeMarkup(offset, undefined, { ...node.attrs, indent: indentOf(was) });
        }
      }
      return;
    }
    if (!LISTS.has(node.type.name)) return;
    let inner = 0;
    node.descendants((child) => {
      if (inner) return false;
      if (child.isTextblock) inner = indentOf(child);
      return !child.isTextblock;
    });
    if (!inner) return;
    tr ??= state.tr;
    const listIndent = indentOf(node) || Math.min(MAX_INDENT, inner);
    tr.setNodeMarkup(offset, undefined, { ...node.attrs, indent: listIndent });
    node.descendants((child, at) => {
      if (child.isTextblock && indentOf(child)) tr!.setNodeMarkup(offset + 1 + at, undefined, { ...child.attrs, indent: 0 });
    });
  });
  return tr;
}

/** At the very start of a top-level text block (not in a list or code). */
function atBlockStart(state: EditorState) {
  const { $from, empty } = state.selection;
  return empty && $from.depth === 1 && $from.parentOffset === 0 && $from.parent.type.name !== "codeBlock";
}

const run = (command: (index: number) => Command) => ({ editor }: { editor: { state: EditorState; view: { dispatch: (tr: Transaction) => void } } }) =>
  command(selectedIndex(editor.state))(editor.state, editor.view.dispatch);

export const Blocks = Extension.create({
  name: "blocks",
  // Below lists: Tab in a list nests the item; only when it can't, the whole list block is indented.
  priority: 50,
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          indent: {
            default: 0,
            keepOnSplit: true,
            parseHTML: (el) => Number(el.getAttribute("data-indent")) || 0,
            renderHTML: (attrs) => (attrs.indent ? { "data-indent": String(attrs.indent) } : {}),
          },
          collapsed: {
            default: false,
            keepOnSplit: false,
            parseHTML: (el) => el.hasAttribute("data-collapsed"),
            renderHTML: (attrs) => (attrs.collapsed ? { "data-collapsed": "" } : {}),
          },
        },
      },
    ];
  },
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive("codeBlock")) return false;
        run((i) => indentBlock(i, 1))({ editor });
        // Keep focus in the note even when the block can't go deeper.
        return true;
      },
      "Shift-Tab": ({ editor }) => {
        if (editor.isActive("codeBlock")) return false;
        run((i) => indentBlock(i, -1))({ editor });
        return true;
      },
      // At the start of a nested block, Backspace first un-nests it; then it merges as usual.
      Backspace: ({ editor }) => atBlockStart(editor.state) && indentOf(editor.state.selection.$from.parent) > 0 && run((i) => indentBlock(i, -1))({ editor }),
      "Mod-Shift-ArrowUp": ({ editor }) => run((i) => moveBlock(i, -1))({ editor }),
      "Mod-Shift-ArrowDown": ({ editor }) => run((i) => moveBlock(i, 1))({ editor }),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blocksKey,
        state: {
          init: (_, { doc }) => blockDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? blockDecorations(tr.doc) : old),
        },
        props: { decorations: (state) => blocksKey.getState(state) },
      }),
      new Plugin({
        key: new PluginKey("listIndent"),
        // Only wrapping into and lifting out of lists (ReplaceAroundStep); typing never runs this.
        appendTransaction: (trs, before, state) =>
          trs.some((t) => t.steps.some((st) => st instanceof ReplaceAroundStep)) ? listKeepsIndent(state, before, trs) : null,
      }),
    ];
  },
});

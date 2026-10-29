import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, NodeSelection, TextSelection, type Command } from "@tiptap/pm/state";
import type { JSONContent } from "@tiptap/react";
import { MemoryStore } from "../store/memoryStore";
import { docText } from "../lib/words";
import { LinkCard } from "./linkCard";
import { blockDecorations, Blocks, deleteBlock, duplicateBlock, indentBlock, insertLine, moveBlock, moveBlockTo, toggleCollapsed } from "./blocks";

const schema = getSchema([StarterKit, LinkCard, Blocks]);
const p = (text: string, indent = 0) => ({ type: "paragraph", attrs: { indent }, content: text ? [{ type: "text", text }] : [] });
const make = (...content: JSONContent[]) => EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content }) });
function apply(state: EditorState, command: Command) {
  let next = state;
  const ok = command(state, (tr) => (next = state.apply(tr)));
  return { ok, state: next };
}
const outline = (state: EditorState) => {
  const rows: string[] = [];
  state.doc.forEach((n) => rows.push(`${"  ".repeat(n.attrs.indent ?? 0)}${n.type.name === "paragraph" ? n.textContent : n.type.name}`));
  return rows;
};

describe("blocks", () => {
  it("Tab nests a block under the one above, and its children move with it", () => {
    let s = make(p("a"), p("b"), p("c", 1));
    expect(apply(s, indentBlock(0, 1)).ok).toBe(false); // nothing above to nest under
    s = apply(s, indentBlock(1, 1)).state;
    expect(outline(s)).toEqual(["a", "  b", "    c"]);
    expect(apply(s, indentBlock(1, 1)).ok).toBe(false); // at most one level deeper than the block above
    s = apply(s, indentBlock(1, -1)).state;
    expect(outline(s)).toEqual(["a", "b", "  c"]);
  });

  it("Enter keeps the indent: a split block stays at the same level", () => {
    const s = make(p("a"), p("bc", 1));
    const at = s.doc.child(0).nodeSize + 2; // after "b"
    let next = s;
    s.apply(s.tr.setSelection(TextSelection.create(s.doc, at)));
    const tr = s.tr.split(at, 1, [{ type: schema.nodes.paragraph, attrs: { ...s.doc.child(1).attrs } }]);
    next = s.apply(tr);
    expect(outline(next)).toEqual(["a", "  b", "  c"]);
  });

  it("moves a block with its children up and down past whole sibling groups", () => {
    let s = make(p("a"), p("a1", 1), p("b"), p("b1", 1));
    s = apply(s, moveBlock(2, -1)).state;
    expect(outline(s)).toEqual(["b", "  b1", "a", "  a1"]);
    s = apply(s, moveBlock(0, 1)).state;
    expect(outline(s)).toEqual(["a", "  a1", "b", "  b1"]);
    expect(apply(s, moveBlock(0, -1)).ok).toBe(false);
  });

  it("drag-drop to the top un-nests what can't be nested there", () => {
    const s = apply(make(p("a"), p("b"), p("c", 1)), moveBlockTo(2, 0)).state;
    expect(outline(s)).toEqual(["c", "a", "b"]);
  });

  it("duplicates and deletes a block with its children; a link card deletes like any block", () => {
    let s = make(p("a"), p("a1", 1), { type: "linkCard", attrs: { url: "https://x.y" } }, p("z"));
    s = apply(s, duplicateBlock(0)).state;
    expect(outline(s)).toEqual(["a", "  a1", "a", "  a1", "linkCard", "z"]);
    s = apply(s, deleteBlock(4)).state;
    expect(outline(s)).toEqual(["a", "  a1", "a", "  a1", "z"]);
    // Backspace on a selected card (NodeSelection) removes it too.
    const c = make(p("a"), { type: "linkCard", attrs: { url: "https://x.y" } });
    const sel = c.apply(c.tr.setSelection(NodeSelection.create(c.doc, c.doc.child(0).nodeSize)));
    expect(outline(sel.apply(sel.tr.deleteSelection()))).toEqual(["a"]);
    expect(outline(apply(make(p("only")), deleteBlock(0)).state)).toEqual([""]);
  });

  it("adds a line above or below a card, so the cursor is never trapped", () => {
    const s = apply(make({ type: "linkCard", attrs: { url: "https://x.y" } }), insertLine(0, "above")).state;
    expect(outline(s)).toEqual(["", "linkCard"]);
    expect(s.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("collapses a block's children", () => {
    const s = apply(make(p("a"), p("a1", 1), p("a2", 2), p("b")), toggleCollapsed(0)).state;
    const decos = blockDecorations(s.doc).find();
    expect(decos.map((d) => (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class)).toEqual(["block-parent block-collapsed", "block-hidden", "block-hidden"]);
    expect(apply(s, toggleCollapsed(3)).ok).toBe(false); // no children
  });

  it("each change is saved as its own event", async () => {
    const store = new MemoryStore();
    let s = make(p("a"), p("b"), p("c"));
    const save = (st: EditorState) => {
      const content = st.doc.toJSON();
      return store.saveDay({ day: "2026-10-29", content, plainText: docText(content) });
    };
    await save(s);
    for (const command of [indentBlock(1, 1), moveBlock(0, 1), duplicateBlock(0), deleteBlock(1)]) {
      s = apply(s, command).state;
      await save(s);
    }
    const page = (await store.getDay("2026-10-29"))!;
    expect((await store.eventsFor(page.id)).filter((e) => e.op !== "props")).toHaveLength(5);
  });
});

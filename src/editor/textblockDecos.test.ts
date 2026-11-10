// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TextSelection, type EditorState, type Plugin } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Blocks, blockDecorations, onlyTextInLines } from "./blocks";
import { LinkHighlight, linksIn } from "./linkHighlight";
import { MathInline, formulasIn } from "./mathInline";
import { TimestampChip, chipsIn } from "./timestampChip";
import { decorateAll } from "./textblockDecos";

/** A decoration as comparable text: where, what kind, its classes / key. */
function rows(set: DecorationSet): string[] {
  return set
    .find()
    .map((d: Decoration) => {
      const t = d as unknown as { type: { attrs?: Record<string, string>; spec?: { key?: string; side?: number } }; spec: { key?: string } };
      const attrs = t.type.attrs ? JSON.stringify(t.type.attrs) : "";
      return `${d.from}-${d.to} ${attrs} ${d.spec.key ?? ""}`;
    })
    .sort();
}

const stateOf = (editor: Editor, name: string) => {
  const plugin = editor.state.plugins.find((p: Plugin) => (p as unknown as { key: string }).key.startsWith(`${name}$`));
  return plugin!.getState(editor.state as EditorState);
};

function rand(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const WORDS = ["a", " ", "[[", "]]", "Project X", "#tag ", "3+4", "(a+b)/2 ", "x^2+1 ", "27,October,2026 Tuesday (22:04:26)", "!", "|", "]", "\n"];

describe("decorations redone only where the text changed", () => {
  it.each([7, 42, 1234])("match a full pass after many random edits (seed %i)", (seed) => {
    const editor = new Editor({
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), Blocks, LinkHighlight, MathInline, TimestampChip],
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Day [[Plan]] #work" }] },
          { type: "paragraph", attrs: { indent: 1 }, content: [{ type: "text", text: "27,October,2026 Tuesday (09:00:00) start 2+2" }] },
          { type: "paragraph", content: [{ type: "text", text: "[[Project A]] notes" }] },
          { type: "paragraph", attrs: { indent: 1 }, content: [{ type: "text", text: "under ![[Other]] #x" }] },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one [[P]]" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }] },
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Sub" }] },
          { type: "paragraph", content: [{ type: "text", text: "text (a+b)/2 and more" }] },
          { type: "codeBlock", content: [{ type: "text", text: "x = 1+2" }] },
          { type: "paragraph", content: [] },
        ],
      },
    });
    const r = rand(seed);
    let fast = 0;
    for (let step = 0; step < 600; step++) {
      const { doc } = editor.state;
      const textblocks: { pos: number; size: number }[] = [];
      doc.descendants((n, pos) => (n.isTextblock ? (textblocks.push({ pos, size: n.content.size }), false) : true));
      const tb = textblocks[Math.floor(r() * textblocks.length)];
      const at = tb.pos + 1 + Math.floor(r() * (tb.size + 1));
      const kind = r();
      const tr = editor.state.tr;
      if (kind < 0.55) {
        const w = WORDS[Math.floor(r() * WORDS.length)];
        if (w === "\n") tr.setSelection(TextSelection.create(doc, at)).split(at);
        else tr.insertText(w, at);
      } else if (kind < 0.8 && tb.size) {
        const from = tb.pos + 1 + Math.floor(r() * tb.size);
        tr.delete(from, Math.min(tb.pos + 1 + tb.size, from + 1 + Math.floor(r() * 4)));
      } else if (kind < 0.88 && doc.childCount > 2) {
        // Join with the line above (Backspace at a line's start).
        const i = 1 + Math.floor(r() * (doc.childCount - 1));
        let pos = 0;
        for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
        try {
          tr.join(pos);
        } catch {
          continue;
        }
      } else {
        const i = Math.floor(r() * doc.childCount);
        let pos = 0;
        for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
        const node = doc.child(i);
        if (node.type.spec.attrs?.indent === undefined) continue;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: Math.floor(r() * 3), collapsed: r() < 0.2 });
      }
      if (!tr.docChanged) continue;
      if (onlyTextInLines(tr)) fast++;
      editor.view.dispatch(tr);
      const d = editor.state.doc;
      expect(rows(stateOf(editor, "blocks"))).toEqual(rows(blockDecorations(d)));
      expect(rows(stateOf(editor, "linkHighlight"))).toEqual(rows(decorateAll(d, linksIn)));
      expect(rows(stateOf(editor, "timestampChip"))).toEqual(rows(decorateAll(d, chipsIn)));
      expect(rows(stateOf(editor, "mathInline").set)).toEqual(rows(decorateAll(d, formulasIn)));
    }
    // Most edits took the quick path.
    expect(fast).toBeGreaterThan(150);
    editor.destroy();
  });

  it("[[ ]] brackets show only on the link with the cursor", () => {
    const editor = new Editor({ extensions: [StarterKit, LinkHighlight], content: "<p>see [[A]][[B]] and ![[C]]</p>" });
    const hidden = () =>
      (editor.view.someProp("decorations", (f) => f(editor.state)) as DecorationSet)
        .find()
        .filter((d: Decoration) => (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class === "wl-bracket")
        .map((d: Decoration) => editor.state.doc.textBetween(d.from, d.to))
        .join(" ");
    editor.commands.setTextSelection(1);
    expect(hidden()).toBe("[[ ]] [[ ]] ![[ ]]");
    // Inside [[B]]: its brackets show, [[A]]'s closing ones stay hidden.
    editor.commands.setTextSelection(14);
    expect(hidden()).toBe("[[ ]] ![[ ]]");
    // Right before the ! of the embed.
    editor.commands.setTextSelection(20);
    expect(hidden()).toBe("[[ ]] [[ ]]");
    editor.destroy();
  });
});

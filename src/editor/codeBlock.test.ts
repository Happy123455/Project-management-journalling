// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { codeBlockFromSelection } from "./codeBlock";

describe("codeBlockFromSelection", () => {
  it("turns several selected lines, lists included, into one code block", () => {
    const editor = new Editor({ extensions: [StarterKit], content: "<p>one</p><ul><li><p>two</p></li></ul><p>three</p><p>after</p>" });
    const end = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize + editor.state.doc.child(2).nodeSize;
    editor.commands.setTextSelection({ from: 2, to: end - 2 });
    codeBlockFromSelection(editor);
    expect(editor.getJSON().content).toEqual([
      { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "one\ntwo\nthree" }] },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ]);
  });
});

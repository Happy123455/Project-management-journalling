// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { undo } from "@tiptap/pm/history";
import { mathFollowUp } from "./mathAuto";

// The same plugin as MathAuto, with the setting on.
const AutoOn = Extension.create({
  name: "mathAutoOn",
  addProseMirrorPlugins: () => [new Plugin({ key: new PluginKey("mathAutoOn"), appendTransaction: (trs, _b, after) => (trs.length === 1 ? mathFollowUp(trs[0], after, true) : null) })],
});

describe("math answer and undo", () => {
  it("undo takes away only the answer", () => {
    const editor = new Editor({ extensions: [StarterKit, AutoOn], content: "<p></p>" });
    for (const ch of "5+7=") editor.view.dispatch(editor.state.tr.insertText(ch));
    expect(editor.state.doc.textContent).toBe("5+7=12");
    undo(editor.state, editor.view.dispatch);
    expect(editor.state.doc.textContent).toBe("5+7=");
  });
});

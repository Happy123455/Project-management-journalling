import { closeHistory } from "@tiptap/pm/history";
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { answerFor, variablesIn } from "../lib/mathEval";
import { blockLines } from "../lib/latex";
import { editorPrefs } from "../lib/editorPrefs";

const key = new PluginKey("mathAuto");

/**
 * Typing "=" right after a sum writes its answer: "12+12=" → "12+12=24", cursor after the answer.
 * Undo (or Backspace over it) takes the answer away again. Not in code. Settings → Editor.
 */
export function mathFollowUp(tr: Transaction, after: EditorState, on = editorPrefs().autoMath): Transaction | null {
  if (!on || !tr.docChanged || tr.steps.length !== 1 || tr.getMeta(key) || tr.getMeta("paste") || tr.getMeta("uiEvent") === "paste") return null;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep)) return null;
  const { from, to, slice } = step as unknown as { from: number; to: number; slice: { size: number; content: { textBetween: (a: number, b: number) => string } } };
  if (from !== to || slice.size !== 1 || slice.content.textBetween(0, 1) !== "=") return null;
  const $at = after.doc.resolve(from);
  if ($at.parent.type.name === "codeBlock" || !$at.parent.isTextblock) return null;
  const before = $at.parent.textBetween(0, $at.parentOffset, undefined, "￼");
  // Variables defined in the lines above ("x = 5", or a math block "r = 3"), like Math Notes.
  const lines: string[] = [];
  after.doc.nodesBetween(0, $at.before(), (n) => {
    if (n.type.name === "mathBlock") lines.push(...blockLines(String(n.attrs.latex ?? "")));
    else if (n.isTextblock) {
      if (n.type.name !== "codeBlock" && n.textContent.includes("=")) lines.push(n.textContent);
      return false;
    }
    return true;
  });
  const answer = answerFor(before, lines.length ? variablesIn(lines) : undefined);
  if (answer === null) return null;
  const text = (before.endsWith(" ") ? " " : "") + answer;
  // Its own undo step: ⌘Z takes the answer away and leaves "5+7=" as typed.
  const next = closeHistory(after.tr.insertText(text, from + 1).setMeta(key, true));
  return next.setSelection(TextSelection.create(next.doc, from + 1 + text.length));
}

export const MathAuto = Extension.create({
  name: "mathAuto",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction: (trs, _before, after) => (trs.length === 1 ? mathFollowUp(trs[0], after) : null),
      }),
    ];
  },
});

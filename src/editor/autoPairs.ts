import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

/** Opening character → its closer. */
export const PAIRS: Record<string, string> = { "[": "]", "(": ")", "{": "}", '"': '"', "'": "'", "`": "`" };
const CLOSERS = new Set(Object.values(PAIRS));
const key = new PluginKey("autoPairs");

/**
 * The follow-up to one typed or deleted character: typing an opener adds its closer after the
 * cursor; typing a closer that's already next steps over it; deleting an opener right before its
 * closer removes both. Quotes only pair at the start of a word ("don't" stays as typed); not in code.
 * Worked out from the change itself, so it works with every keyboard (Android ones don't send keys).
 */
export function pairFollowUp(tr: Transaction, before: EditorState, after: EditorState): Transaction | null {
  if (!tr.docChanged || tr.steps.length !== 1 || tr.getMeta(key) || tr.getMeta("paste") || tr.getMeta("uiEvent") === "paste") return null;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep)) return null;
  const { from, to, slice } = step as unknown as { from: number; to: number; slice: { size: number; content: { textBetween: (a: number, b: number) => string } } };
  const $at = after.doc.resolve(Math.min(from, after.doc.content.size));
  if ($at.parent.type.name === "codeBlock") return null;
  const charAt = (state: EditorState, pos: number) => (pos >= 0 && pos < state.doc.content.size ? state.doc.textBetween(pos, Math.min(pos + 1, state.doc.content.size)) : "");

  // One character typed.
  if (from === to && slice.size === 1) {
    const typed = slice.content.textBetween(0, 1);
    if (CLOSERS.has(typed) && charAt(after, from + 1) === typed) {
      // It was already there: keep just one, cursor after it.
      return after.tr.delete(from + 1, from + 2).setMeta(key, true);
    }
    const close = PAIRS[typed];
    if (!close) return null;
    if (close === typed && /[\p{L}\p{N}]/u.test(charAt(before, from - 1))) return null;
    const next = after.tr.insertText(close, from + 1).setMeta(key, true);
    return next.setSelection(TextSelection.create(next.doc, from + 1));
  }
  // One character deleted: an opener whose closer sits right after it.
  if (slice.size === 0 && to === from + 1) {
    const gone = charAt(before, from);
    if (PAIRS[gone] && charAt(after, from) === PAIRS[gone] && charAt(before, from + 1) === PAIRS[gone]) {
      return after.tr.delete(from, from + 1).setMeta(key, true);
    }
  }
  return null;
}

export const AutoPairs = Extension.create({
  name: "autoPairs",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction: (trs, before, after) => (trs.length === 1 ? pairFollowUp(trs[0], before, after) : null),
      }),
    ];
  },
});

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { decorateAll, redecorate } from "./textblockDecos";
import katex from "katex";
import { inlineFormulas } from "../lib/mathSmart";
import { editorPrefs } from "../lib/editorPrefs";

/**
 * Plain maths written in the text ("(a+b+c+d)/2", "x^2+1", "sqrt(b^2-4ac)") is drawn as a proper
 * formula, no LaTeX needed. Only a display: the text stays as typed, and the paragraph with the
 * cursor in it shows the plain text so it can be edited. Settings → Editor → Draw formulas.
 */

/** Formulas in one paragraph: the drawn formula, and the typed text hidden behind it. */
export function formulasIn(node: PMNode, start: number, out: Decoration[]) {
  if (node.type.name === "codeBlock" || node.type.name === "mathBlock") return;
  // Text pieces one by one, so a link or code mark breaks the run.
  node.forEach((child, offset) => {
    if (!child.isText || !child.text || child.marks.some((m) => m.type.name === "code" || m.type.name === "link")) return;
    const text = child.text;
    for (const h of inlineFormulas(text)) {
      const from = start + offset + h.from;
      const to = start + offset + h.to;
      const raw = text.slice(h.from, h.to);
      out.push(
        Decoration.widget(from, () => formulaEl(h.latex, raw), { side: -1, key: `pm:${h.latex}`, ignoreSelection: true }),
        Decoration.inline(from, to, { class: "pm-raw" }),
      );
    }
  });
}

function formulaEl(latex: string, raw: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "pm-formula";
  el.contentEditable = "false";
  el.title = raw;
  try {
    el.innerHTML = katex.renderToString(latex, { throwOnError: true, strict: "ignore" });
  } catch {
    el.textContent = raw;
  }
  return el;
}

/**
 * Worked out once per paragraph as it changes (it used to be every formula of the whole note on
 * every letter typed); the paragraph with the cursor shows its plain text.
 */
interface MathState {
  on: boolean;
  set: DecorationSet;
}
const key = new PluginKey<MathState>("mathInline");
const build = (doc: PMNode): MathState => (editorPrefs().prettyMath ? { on: true, set: decorateAll(doc, formulasIn) } : { on: false, set: DecorationSet.empty });

function decorations(state: EditorState): DecorationSet {
  const { on, set } = key.getState(state)!;
  if (!on || !editorPrefs().prettyMath || set === DecorationSet.empty) return DecorationSet.empty;
  const $from = state.selection.$from;
  if ($from.depth === 0) return set;
  const start = $from.before($from.depth);
  const editing = set.find(start, start + $from.parent.nodeSize);
  return editing.length ? set.remove(editing) : set;
}

export const MathInline = Extension.create({
  name: "mathInline",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, { doc }) => build(doc),
          // Settings → Editor → Draw formulas switched: done again with the next change.
          apply: (tr, old) => (old.on !== editorPrefs().prettyMath ? build(tr.doc) : old.on && tr.docChanged ? { on: true, set: redecorate(tr, old.set, formulasIn) } : old),
        },
        props: { decorations },
      }),
    ];
  },
});

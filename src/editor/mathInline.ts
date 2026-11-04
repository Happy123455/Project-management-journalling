import { Extension } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import katex from "katex";
import { inlineFormulas } from "../lib/mathSmart";
import { editorPrefs } from "../lib/editorPrefs";

/**
 * Plain maths written in the text ("(a+b+c+d)/2", "x^2+1", "sqrt(b^2-4ac)") is drawn as a proper
 * formula, no LaTeX needed. Only a display: the text stays as typed, and the paragraph with the
 * cursor in it shows the plain text so it can be edited. Settings → Editor → Draw formulas.
 */

type Hit = { from: number; to: number; latex: string; para: number };
const found = new WeakMap<PMNode, Hit[]>();

function hitsIn(doc: PMNode): Hit[] {
  let hits = found.get(doc);
  if (hits) return hits;
  hits = [];
  const list = hits;
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock" || node.type.name === "mathBlock") return false;
    if (!node.isTextblock) return true;
    // Text pieces one by one, so a link or code mark breaks the run.
    node.forEach((child, offset) => {
      if (!child.isText || !child.text || child.marks.some((m) => m.type.name === "code" || m.type.name === "link")) return;
      for (const h of inlineFormulas(child.text)) list.push({ from: pos + 1 + offset + h.from, to: pos + 1 + offset + h.to, latex: h.latex, para: pos });
    });
    return false;
  });
  found.set(doc, hits);
  return hits;
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

function decorations(state: EditorState): DecorationSet {
  if (!editorPrefs().prettyMath) return DecorationSet.empty;
  const hits = hitsIn(state.doc);
  if (!hits.length) return DecorationSet.empty;
  const $from = state.selection.$from;
  const editing = $from.depth > 0 ? $from.before($from.depth) : -1;
  const decos: Decoration[] = [];
  for (const h of hits) {
    if (h.para === editing) continue;
    const raw = state.doc.textBetween(h.from, h.to);
    decos.push(
      Decoration.widget(h.from, () => formulaEl(h.latex, raw), { side: -1, key: `pm:${h.latex}`, ignoreSelection: true }),
      Decoration.inline(h.from, h.to, { class: "pm-raw" }),
    );
  }
  return DecorationSet.create(state.doc, decos);
}

export const MathInline = Extension.create({
  name: "mathInline",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mathInline"),
        props: { decorations },
      }),
    ];
  },
});

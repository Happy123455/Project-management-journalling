import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { CLASH, clashOf } from "../sync/merge";
import { LID } from "../sync/lineIds";
import { logAnomaly, short } from "../sync/anomalies";

/**
 * Sync clashes in the open note: both devices changed the same line differently, so both versions
 * were kept, each marked with the device it came from (sync/merge.ts clashPair). Each pair gets a
 * tinted border with the device's name, and a bar under it: keep 📱 Phone's, 💻 Mac's, Both, or
 * ✎ Edit (both kept, cursor in the first to adjust). The choice is an ordinary edit, so it syncs
 * and the other device's bar goes away too.
 */
interface Member {
  pos: number;
  node: PMNode;
  side: string | null;
}

const key = new PluginKey<DecorationSet>("clash");
const icon = (side: string) => (/phone/i.test(side) ? "📱" : /mac/i.test(side) ? "💻" : "•");
const textOf = (n: PMNode) => n.textContent;

/** Clash groups in the doc with at least two lines (the line whose id is the group counts too). */
export function clashGroups(doc: PMNode): Map<string, Member[]> {
  const marked = new Map<string, Member[]>();
  const byLid = new Map<string, { pos: number; node: PMNode }>();
  let any = false;
  doc.descendants((node, pos) => {
    if (node.isInline) return false;
    const c = clashOf(node);
    if (c) {
      any = true;
      marked.set(c.group, [...(marked.get(c.group) ?? []), { pos, node, side: c.side }]);
    }
    const lid = node.attrs[LID];
    if (typeof lid === "string") byLid.set(lid, { pos, node });
    return !node.isTextblock;
  });
  const out = new Map<string, Member[]>();
  if (!any) return out;
  for (const [group, list] of marked) {
    const own = byLid.get(group);
    if (own && !list.some((m) => m.pos === own.pos)) list.push({ ...own, side: null });
    list.sort((a, b) => a.pos - b.pos);
    if (list.length >= 2) out.set(group, list);
  }
  return out;
}

function build(state: EditorState): DecorationSet {
  const groups = clashGroups(state.doc);
  if (!groups.size) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (const [group, list] of groups) {
    for (const m of list)
      decos.push(Decoration.node(m.pos, m.pos + m.node.nodeSize, { class: "clash-line", "data-side": m.side ? `${icon(m.side)} ${m.side}` : "earlier" }));
    const last = list[list.length - 1];
    decos.push(Decoration.widget(last.pos + last.node.nodeSize, (view) => bar(view, group), { side: 1, key: `clash-${group}-${list.map((m) => m.side).join(",")}`, ignoreSelection: true }));
  }
  return DecorationSet.create(state.doc, decos);
}

const firstSeen = new Map<string, number>();

/** Keep `side`'s line (null = all of them), take the clash marks off. */
export function resolveClash(view: EditorView, group: string, keep: string | null | "edit") {
  const list = clashGroups(view.state.doc).get(group);
  if (!list) return;
  const tr = view.state.tr;
  const sides: Record<string, string> = {};
  for (const m of list) sides[m.side ?? "earlier"] = textOf(m.node);
  const drop = keep && keep !== "edit" ? list.filter((m) => (m.side ?? "earlier") !== keep) : [];
  // Never drop every line: an unknown side keeps them all.
  const dropping = drop.length < list.length ? drop : [];
  for (const m of [...list].reverse()) {
    if (dropping.includes(m)) tr.delete(tr.mapping.map(m.pos), tr.mapping.map(m.pos + m.node.nodeSize));
    else if (m.node.attrs[CLASH]) tr.setNodeAttribute(tr.mapping.map(m.pos), CLASH, null);
  }
  if (keep === "edit") {
    const first = list[0];
    const end = tr.mapping.map(first.pos + first.node.nodeSize) - 1;
    try {
      tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1));
    } catch {
      // cursor stays
    }
  }
  view.dispatch(tr.scrollIntoView());
  if (keep === "edit") view.focus();
  const since = firstSeen.get(group);
  logAnomaly({
    kind: "resolved",
    path: "local",
    text: `clash ${keep === null ? "kept both" : keep === "edit" ? "kept both to edit" : `kept ${keep}`}: ${Object.entries(sides).map(([k, v]) => `${k} "${short(v, 50)}"`).join(" / ")}`,
    detail: { line: group, choice: keep ?? "both", sides, shownForMs: since ? Date.now() - since : undefined },
  });
}

function bar(view: EditorView, group: string): HTMLElement {
  if (!firstSeen.has(group)) firstSeen.set(group, Date.now());
  const list = clashGroups(view.state.doc).get(group) ?? [];
  const el = document.createElement("div");
  el.className = "clash-bar";
  el.contentEditable = "false";
  const label = document.createElement("span");
  label.className = "clash-label";
  label.textContent = "⚡ Both devices changed this line. Keep:";
  el.append(label);
  const button = (text: string, choice: string | null | "edit", title: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resolveClash(view, group, choice);
    });
    el.append(b);
  };
  for (const m of list) if (m.side) button(`${icon(m.side)} ${m.side}`, m.side, `Keep ${m.side}'s line, remove the other`);
  if (list.some((m) => !m.side)) button("Earlier", "earlier", "Keep the line as it was before, remove the others");
  button("Both", null, "Keep both lines");
  button("✎ Edit", "edit", "Keep both lines and put the cursor there to adjust them");
  return el;
}

/** Shows sync clashes in the note and lets Hapi pick a side. */
export const Clashes = Extension.create({
  name: "clashes",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_c, state) => build(state),
          apply: (tr, old, _o, state) => (tr.docChanged ? build(state) : old),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});

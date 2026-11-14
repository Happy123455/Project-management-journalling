import { Extension, getExtensionField } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { REMOTE } from "../sync/liveTyping";
import { contentKey, LID, randomLid, siblingIds } from "../sync/lineIds";

const key = new PluginKey("lineIds");
/** Meta on the transaction that only gives an opened note's lines their ids (not saved as an edit). */
export const LID_INIT = "lidInit";

const hasLid = (n: PMNode) => !n.isInline && n.type.spec.attrs?.[LID] !== undefined;

/** Ids the doc is missing (or has twice among siblings): [pos, id] to set. */
function fixes(state: EditorState, mode: "content" | "local", old?: PMNode): [number, string][] {
  const out: [number, string][] = [];
  // Ids of lines that just went away (Source mode read-back, a note replaced): reused by content.
  let gone: Map<string, string[]> | null = null;
  const reuse = (n: PMNode): string | undefined => {
    if (!old) return undefined;
    if (!gone) {
      const now = new Set<string>();
      state.doc.descendants((d) => {
        if (d.attrs[LID]) now.add(d.attrs[LID]);
        return !d.isTextblock;
      });
      gone = new Map();
      old.descendants((d) => {
        const id = d.attrs[LID];
        if (id && !now.has(id)) {
          const k = contentKey(d.toJSON());
          gone!.set(k, [...(gone!.get(k) ?? []), id]);
        }
        return !d.isTextblock;
      });
    }
    return gone.get(contentKey(n.toJSON()))?.shift();
  };
  const level = (parent: PMNode, start: number) => {
    const seen = new Set<string>();
    let bad = false;
    parent.forEach((c) => {
      if (!hasLid(c)) return;
      const id = c.attrs[LID];
      if (!id || seen.has(id)) bad = true;
      seen.add(id);
    });
    if (bad) {
      const kids: PMNode[] = [];
      parent.forEach((c) => kids.push(c));
      const made = mode === "content" ? siblingIds(kids.map((c) => c.toJSON())) : [];
      const taken = new Set<string>();
      parent.forEach((c, offset, i) => {
        if (!hasLid(c)) return;
        const id = c.attrs[LID];
        if (id && !taken.has(id)) return void taken.add(id);
        let next = mode === "content" ? made[i] : reuse(c) ?? randomLid();
        while (taken.has(next)) next += "+";
        taken.add(next);
        out.push([start + offset, next]);
      });
    }
    parent.forEach((c, offset) => {
      if (!c.isTextblock && !c.isLeaf) level(c, start + offset + 1);
    });
  };
  level(state.doc, 0);
  return out;
}

function apply(tr: Transaction, list: [number, string][]): Transaction {
  for (const [pos, id] of list) tr.setNodeAttribute(pos, LID, id);
  return tr.setMeta(key, true).setMeta("addToHistory", false);
}

/** Hidden line ids (see sync/lineIds.ts): kept on every block, made for new and old lines. */
export const LineIds = Extension.create({
  name: "lineIds",
  addGlobalAttributes() {
    const types = this.extensions
      .filter((e) => e.type === "node" && e.name !== "doc" && e.name !== "text" && !getExtensionField(e, "inline"))
      .filter((e) => !String(getExtensionField(e, "group") ?? "").split(" ").includes("inline"))
      .map((e) => e.name);
    return [
      {
        types,
        attributes: {
          [LID]: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-lid"),
            renderHTML: (attrs) => (attrs[LID] ? { "data-lid": attrs[LID] } : {}),
          },
          // Which side of a sync clash this line is (sync/merge.ts clashPair, editor/clash.ts).
          clash: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-clash"),
            renderHTML: (attrs) => (attrs.clash ? { "data-clash": attrs.clash } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction: (trs, oldState, state) => {
          if (!trs.some((tr) => tr.docChanged) || trs.some((tr) => tr.getMeta(key))) return null;
          const fromElsewhere = trs.some((tr) => tr.getMeta(REMOTE) || tr.getMeta(LID_INIT));
          const list = fixes(state, fromElsewhere ? "content" : "local", oldState.doc);
          return list.length ? apply(state.tr, list) : null;
        },
        view: (view) => {
          // An opened note whose lines have no ids yet: give them ids from content, not saved on its own.
          queueMicrotask(() => {
            if ((view as { isDestroyed?: boolean }).isDestroyed) return;
            const list = fixes(view.state, "content");
            if (list.length) view.dispatch(apply(view.state.tr, list).setMeta(LID_INIT, true));
          });
          return {};
        },
      }),
    ];
  },
});

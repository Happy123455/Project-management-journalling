import { Extension } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { cleanInfo, infoLabel, loadInfoDefaults, type BlockInfo } from "../lib/blockInfo";

const TYPES = ["paragraph", "heading", "listItem", "taskItem"];
/** Blocks that can carry info; only text blocks take the "new blocks" defaults. */
export const INFO_TYPES = [...TYPES, "promptBlock", "codeBlock", "linkCard", "attachmentFile", "blockquote"];

function infoDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.attrs?.info || !INFO_TYPES.includes(node.type.name)) return;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-info-label": infoLabel(node.attrs.info as BlockInfo), class: "has-info" }));
  });
  return DecorationSet.create(doc, decos);
}

/**
 * Block info: properties stored on a block (saved in the note, so they sync). New blocks get
 * the defaults chosen with "Use for new blocks"; existing blocks are never changed by that.
 */
export const BlockInfoExtension = Extension.create({
  name: "blockInfo",
  addGlobalAttributes() {
    return [
      {
        types: INFO_TYPES,
        attributes: {
          info: {
            default: null,
            parseHTML: (el) => {
              try {
                return cleanInfo(JSON.parse(el.getAttribute("data-info") ?? "null"));
              } catch {
                return null;
              }
            },
            renderHTML: (attrs) => (attrs.info ? { "data-info": JSON.stringify(attrs.info) } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: new PluginKey("blockInfo"),
        // A block that has just been created (empty, in the part that changed) takes the defaults.
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged) || trs.some((t) => t.getMeta("aiActor") || t.getMeta("noInfoDefaults"))) return null;
          const defaults = cleanInfo(loadInfoDefaults());
          if (!defaults) return null;
          let tr = state.tr;
          let changed = false;
          const ranges: [number, number][] = [];
          for (const t of trs) t.mapping.maps.forEach((map) => map.forEach((_a, _b, from, to) => ranges.push([from, to])));
          for (const [from, to] of ranges) {
            state.doc.nodesBetween(Math.max(0, from - 1), Math.min(state.doc.content.size, to + 1), (node, pos) => {
              if (!TYPES.includes(node.type.name) || node.attrs.info || node.textContent.length) return;
              tr = tr.setNodeAttribute(pos, "info", defaults);
              changed = true;
            });
          }
          return changed ? tr : null;
        },
        // Show a block's info as a small line under it (worked out again only when the note changes).
        state: {
          init: (_, { doc }) => infoDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? infoDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

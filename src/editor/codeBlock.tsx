import { useMemo, useState } from "react";
import CodeBlock from "@tiptap/extension-code-block";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from "@tiptap/react";

/** "```" or "```js" alone on a line: Enter turns the line into a code block in that language. */
export const FENCE_RE = /^```([\w+#-]*)$/;

export async function copyText(text: string) {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await writeText(text);
    } catch {
      // Fall through to the WebView's clipboard.
    }
  }
  try {
    return await navigator.clipboard.writeText(text);
  } catch {
    // Older WebViews: copy through a hidden text box.
    const box = document.createElement("textarea");
    box.value = text;
    box.style.cssText = "position:fixed;opacity:0;top:0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    if (!ok) throw new Error("Copy isn't available here");
  }
}

/** ▾ / ▸ in a block's header: folds the block to its header line (kept in the note as `collapsed`). */
export function FoldButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="block-fold"
      aria-label={collapsed ? "Expand" : "Collapse"}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand" : "Collapse"}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language = (node.attrs.language as string | null) ?? "";
  const collapsed = !!node.attrs.collapsed;
  const firstLine = useMemo(() => {
    const lines = node.textContent.split("\n");
    return `${lines[0].slice(0, 60)}${lines.length > 1 ? `  … ${lines.length} lines` : ""}`;
  }, [node.textContent]);

  const copy = async () => {
    try {
      await copyText(node.textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; nothing to undo.
    }
  };

  return (
    <NodeViewWrapper className={collapsed ? "code-block collapsed" : "code-block"}>
      <div className="code-block-bar" contentEditable={false}>
        <FoldButton collapsed={collapsed} onToggle={() => updateAttributes({ collapsed: !collapsed })} />
        {collapsed && <span className="code-fold-preview">{firstLine}</span>}
        <input
          className="code-language"
          value={language}
          placeholder="plain text"
          aria-label="Code language"
          spellCheck={false}
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ language: e.target.value.trim().toLowerCase() || null })}
        />
        <button
          type="button"
          className={copied ? "code-copy copied" : "code-copy"}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={copy}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
      {!collapsed && node.textContent.split("\n").length > 4 && (
        // Long code: Copy and Collapse at the bottom too, so they're there without scrolling back up.
        <div className="code-bottom-row" contentEditable={false}>
          <button
            type="button"
            className={copied ? "code-copy copied" : "code-copy"}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={copy}
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="block-bottom-fold code-bottom-fold"
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => updateAttributes({ collapsed: true })}
            title="Collapse"
          >
            ▴ Collapse
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** Obsidian-style code block: mono font, language label and a Copy button. */
export const JournalCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: { default: false, parseHTML: (el) => el.getAttribute("data-collapsed") === "true", renderHTML: (a) => (a.collapsed ? { "data-collapsed": "true" } : {}) },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      // Leaving a nested code block (Enter on its empty last lines, ↓ at its end) made the new line at
      // no indent: it fell out of the box, so the points written next were a separate block and the
      // box's bottom ⧉ only copied those (Hapi, 2026-11-07). The new line keeps the code's nesting.
      new Plugin({
        key: new PluginKey("codeExitIndent"),
        appendTransaction: (trs, before, state) => {
          // ↓ out of the code into the empty line already under it (the note's last line): same nesting.
          const $was = before.selection.$from;
          const $now = state.selection.$from;
          if ($was.depth === 1 && $was.parent.type.name === "codeBlock" && Number($was.parent.attrs.indent ?? 0) && $now.depth === 1 && $now.parent.type.name === "paragraph" && !$now.parent.content.size && !Number($now.parent.attrs.indent ?? 0) && $now.index(0) > 0) {
            const prev = state.doc.child($now.index(0) - 1);
            if (prev.type.name === "codeBlock" && prev.eq(before.doc.nodeAt($was.before(1)) ?? prev))
              return state.tr.setNodeMarkup($now.before(1), undefined, { ...$now.parent.attrs, indent: Number(prev.attrs.indent) });
          }
          if (!trs.some((t) => t.docChanged)) return null;
          const mapping = new Mapping();
          for (const t of trs) mapping.appendMapping(t.mapping);
          const back = mapping.invert();
          let tr: Transaction | null = null;
          let pos = 0;
          for (let i = 0; i + 1 < state.doc.childCount; i++) {
            const code = state.doc.child(i);
            const next = state.doc.child(i + 1);
            const at = pos;
            pos += code.nodeSize;
            const indent = Number(code.attrs.indent ?? 0) || 0;
            if (code.type.name !== "codeBlock" || !indent || next.type.name !== "paragraph" || next.content.size || Number(next.attrs.indent ?? 0)) continue;
            // Only a line that just appeared after the code (not one that was already there).
            const old = back.map(at, 1);
            const $old = old < before.doc.content.size ? before.doc.resolve(old) : null;
            const oldIndex = $old ? $old.index(0) : -1;
            const was = oldIndex >= 0 && oldIndex + 1 < before.doc.childCount ? before.doc.child(oldIndex + 1) : null;
            if (was && was.type.name === "paragraph" && !was.content.size && !Number(was.attrs.indent ?? 0)) continue;
            tr ??= state.tr;
            tr.setNodeMarkup(pos, undefined, { ...next.attrs, indent });
          }
          return tr;
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "paragraph") return false;
        const fence = $from.parent.textContent.match(FENCE_RE);
        if (!fence || $from.parentOffset !== $from.parent.content.size) return false;
        return editor
          .chain()
          .deleteRange({ from: $from.start(), to: $from.end() })
          .setCodeBlock({ ...(fence[1] ? { language: fence[1] } : {}), indent: Number($from.parent.attrs.indent ?? 0) || 0 } as { language: string })
          .run();
      },
    };
  },
});

/**
 * The toolbar's Code button. With several lines selected, all of them become one code block
 * (also from lists and headings), not a block per line. Anything that isn't text (a photo, a
 * video) would be lost in a code block, so then each line is toggled on its own as before.
 */
export function codeBlockFromSelection(editor: Editor) {
  const { state } = editor;
  const { $from, $to, empty } = state.selection;
  if (empty || $from.sameParent($to) || editor.isActive("codeBlock")) return editor.chain().focus().toggleCodeBlock().run();
  const from = $from.before(1);
  const to = $to.after(1);
  let media = false;
  state.doc.nodesBetween(from, to, (n) => {
    if (n.isInline && !n.isText && n.type.name !== "hardBreak") media = true;
    return !media;
  });
  if (media) return editor.chain().focus().toggleCodeBlock().run();
  const text = state.doc.textBetween(from, to, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : ""));
  // Keeps the first line's nesting: at no indent the code fell out of the box it was made in, and
  // the lines under it became its children (⧉ then copied the wrong part).
  const indent = Number($from.node(1).attrs.indent ?? 0) || 0;
  return editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, { type: "codeBlock", attrs: { indent }, content: text ? [{ type: "text", text }] : [] })
    .run();
}

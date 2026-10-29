import { useState } from "react";
import CodeBlock from "@tiptap/extension-code-block";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";

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

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language = (node.attrs.language as string | null) ?? "";

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
    <NodeViewWrapper className="code-block">
      <div className="code-block-bar" contentEditable={false}>
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
    </NodeViewWrapper>
  );
}

/** Obsidian-style code block: mono font, language label and a Copy button. */
export const JournalCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
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
          .setCodeBlock(fence[1] ? { language: fence[1] } : undefined)
          .run();
      },
    };
  },
});

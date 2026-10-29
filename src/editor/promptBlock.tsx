import { useState } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { fillPrompt, promptFields } from "../lib/prompt";
import { showToast } from "../lib/toast";
import { copyText } from "./codeBlock";

const EXAMPLE = "Write a {{tone}} message to {{person}} about {{topic}}. Keep it under {{length}} words.";

/** "/" Prompt: a reusable prompt with {{fields}}; fill them in and Copy the finished prompt. No AI is called. */
function PromptView({ node, updateAttributes, editor }: NodeViewProps) {
  const { title, template, values } = node.attrs as { title: string; template: string; values: Record<string, string> };
  const [editing, setEditing] = useState(!template);
  const fields = promptFields(template);
  const finished = fillPrompt(template, values);
  const missing = fields.filter((f) => !values[f]?.trim());
  const readOnly = !editor.isEditable;

  return (
    <NodeViewWrapper className="prompt-block" data-drag-handle="">
      <div className="prompt-head" contentEditable={false}>
        <span aria-hidden>🧩</span>
        <input className="prompt-title" value={title} placeholder="Prompt name" readOnly={readOnly} onChange={(e) => updateAttributes({ title: e.target.value })} />
        <button type="button" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit template"}</button>
      </div>
      {editing ? (
        <textarea
          className="prompt-template"
          value={template}
          placeholder={EXAMPLE}
          rows={4}
          readOnly={readOnly}
          onChange={(e) => updateAttributes({ template: e.target.value })}
        />
      ) : null}
      {fields.length > 0 && (
        <div className="prompt-fields">
          {fields.map((f) => (
            <label key={f}>
              <span>{f}</span>
              <input value={values[f] ?? ""} readOnly={readOnly} onChange={(e) => updateAttributes({ values: { ...values, [f]: e.target.value } })} />
            </label>
          ))}
        </div>
      )}
      {!editing && <pre className="prompt-preview">{finished || "Tap Edit template and write your prompt, with {{fields}} for the parts that change."}</pre>}
      <div className="prompt-actions" contentEditable={false}>
        <span className="hint">{fields.length ? (missing.length ? `${missing.length} field${missing.length === 1 ? "" : "s"} empty` : "Ready") : "Add {{fields}} for the parts that change"}</span>
        <button
          type="button"
          disabled={!template.trim()}
          onClick={async () => {
            await copyText(finished);
            showToast("Prompt copied");
          }}
        >
          📋 Copy
        </button>
        {fields.length > 0 && (
          <button type="button" disabled={readOnly} onClick={() => updateAttributes({ values: {} })}>Clear</button>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const PromptBlock = Node.create({
  name: "promptBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      title: { default: "", parseHTML: (el) => el.getAttribute("data-title") ?? "" },
      template: { default: "", parseHTML: (el) => el.getAttribute("data-template") ?? el.textContent ?? "" },
      values: {
        default: {},
        parseHTML: (el) => {
          try {
            return JSON.parse(el.getAttribute("data-values") ?? "{}");
          } catch {
            return {};
          }
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-prompt-block]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    return ["div", mergeAttributes(HTMLAttributes, { "data-prompt-block": "", "data-title": a.title, "data-template": a.template, "data-values": JSON.stringify(a.values) }), a.template];
  },
  // Copied, searched and counted as the template itself.
  renderText({ node }) {
    return [node.attrs.title, node.attrs.template].filter(Boolean).join("\n");
  },
  addNodeView() {
    return ReactNodeViewRenderer(PromptView);
  },
});

import { useEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { askAi } from "../ai/client";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { fillPrompt, promptFields } from "../lib/prompt";
import { showToast } from "../lib/toast";
import { copyText, FoldButton } from "./codeBlock";

const EXAMPLE = "Write a {{tone}} message to {{person}} about {{topic}}. Keep it under {{length}} words.";

type Mode = "grammar" | "refine";

const BRACES = "Words inside {curly braces} describe a word the writer couldn't find: replace each with the single best word or phrase for it (no braces left).";
const SYSTEM: Record<Mode, string> = {
  grammar: `Fix only spelling, grammar and punctuation in the user's text. Keep their wording, meaning, tone and language. ${BRACES} Reply with the corrected text only.`,
  refine:
    "You turn a person's rough description of the prompt they want into a ready-to-use prompt they will paste into another AI. " +
    "Understand what they are really after, then write it as one short, refined prompt: the task, the context that matters, key constraints and the output they want. " +
    `${BRACES} Keep it tight, in the second person to the AI, in the user's language. Reply with the prompt only: no title, no quotes, no notes.`,
};

/** AI answers can come wrapped in quotes, a code fence or a thinking block; keep just the prompt. */
export function cleanAnswer(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()
    .replace(/^```[\w-]*\n([\s\S]*?)\n```$/, "$1")
    .replace(/^"([\s\S]*)"$/, "$1")
    .trim();
}

/**
 * A text field inside a note block that keeps its letters to itself while typing and writes them
 * into the note after a short pause (and on leaving the field). Writing into the note on every
 * letter redrew the whole block and saved the page each time, which made typing hang.
 */
function useLazyText(value: string, commit: (v: string) => void) {
  const [text, setText] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ text, commit });
  latest.current = { text, commit };
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  const flush = () => {
    window.clearTimeout(timer.current);
    editing.current = false;
    if (latest.current.text !== value) latest.current.commit(latest.current.text);
  };
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (editing.current) latest.current.commit(latest.current.text);
  }, []);
  return {
    value: text,
    onChange: (e: { target: { value: string } }) => {
      editing.current = true;
      setText(e.target.value);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 600);
    },
    onBlur: flush,
  };
}

function LazyInput({ value, onCommit, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onCommit: (v: string) => void }) {
  return <input {...rest} {...useLazyText(value, onCommit)} />;
}

function LazyTextarea({ value, onCommit, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onCommit: (v: string) => void }) {
  return <textarea {...rest} {...useLazyText(value, onCommit)} />;
}

/**
 * "/" Prompt: write roughly what you want on top (with {a word you can't find} in braces), pick
 * "Fix grammar" or "Make it a good prompt", and the AI writes the ready prompt below, with Copy.
 */
function PromptBuilder({ node, updateAttributes, editor }: NodeViewProps) {
  const { title, raw, mode, output } = node.attrs as { title: string; raw: string; mode: Mode; output: string };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const readOnly = !editor.isEditable;
  const convert = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    setError("");
    try {
      const answer = await askAi({ task: mode === "grammar" ? "grammar" : "organise", system: SYSTEM[mode], text: raw, maxTokens: 1200 });
      updateAttributes({ output: cleanAnswer(answer.text) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <NodeViewWrapper className={node.attrs.collapsed ? `${"prompt-block prompt-builder"} collapsed` : "prompt-block prompt-builder"} data-drag-handle="">
      <div className="prompt-head" contentEditable={false}>
        <FoldButton collapsed={!!node.attrs.collapsed} onToggle={() => updateAttributes({ collapsed: !node.attrs.collapsed })} />
        <span aria-hidden>🧩</span>
        <LazyInput className="prompt-title" value={title} placeholder="Prompt name" readOnly={readOnly} onCommit={(v) => updateAttributes({ title: v })} />
      </div>
      <LazyTextarea
        className="prompt-template prompt-raw"
        value={raw}
        rows={4}
        readOnly={readOnly}
        placeholder="Describe what you want the prompt to do. Can't find a word? Describe it in {curly braces}."
        onCommit={(v) => updateAttributes({ raw: v })}
      />
      <div className="prompt-modes" contentEditable={false} role="radiogroup" aria-label="What to do">
        {(
          [
            ["grammar", "✏️ Only fix grammar"],
            ["refine", "✨ Make it a good prompt"],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "active" : ""} disabled={readOnly} onClick={() => updateAttributes({ mode: m })}>
            {label}
          </button>
        ))}
        <button type="button" className="prompt-convert" disabled={readOnly || busy || !raw.trim()} onClick={() => void convert()}>
          {busy ? "Writing…" : "↓ Convert"}
        </button>
      </div>
      {error && <p className="hint prompt-error">{error}</p>}
      <div className="prompt-output-box">
        <LazyTextarea
          className="prompt-template prompt-output"
          value={output}
          rows={Math.min(14, Math.max(4, output.split("\n").length + 1))}
          readOnly={readOnly}
          placeholder="The ready-to-go prompt appears here."
          onCommit={(v) => updateAttributes({ output: v })}
        />
        <button
          type="button"
          className="prompt-copy"
          disabled={!output.trim()}
          onClick={async () => {
            await copyText(output);
            showToast("Prompt copied");
          }}
        >
          📋 Copy
        </button>
      </div>
    </NodeViewWrapper>
  );
}

/** Older prompt blocks: a reusable template with {{fields}}; fill them in and Copy. */
function PromptTemplateView({ node, updateAttributes, editor }: NodeViewProps) {
  const { title, template, values } = node.attrs as { title: string; template: string; values: Record<string, string> };
  const [editing, setEditing] = useState(!template);
  const fields = promptFields(template);
  const finished = fillPrompt(template, values);
  const missing = fields.filter((f) => !values[f]?.trim());
  const readOnly = !editor.isEditable;

  return (
    <NodeViewWrapper className={node.attrs.collapsed ? `${"prompt-block"} collapsed` : "prompt-block"} data-drag-handle="">
      <div className="prompt-head" contentEditable={false}>
        <FoldButton collapsed={!!node.attrs.collapsed} onToggle={() => updateAttributes({ collapsed: !node.attrs.collapsed })} />
        <span aria-hidden>🧩</span>
        <LazyInput className="prompt-title" value={title} placeholder="Prompt name" readOnly={readOnly} onCommit={(v) => updateAttributes({ title: v })} />
        <button type="button" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit template"}</button>
      </div>
      {editing ? (
        <LazyTextarea
          className="prompt-template"
          value={template}
          placeholder={EXAMPLE}
          rows={4}
          readOnly={readOnly}
          onCommit={(v) => updateAttributes({ template: v })}
        />
      ) : null}
      {fields.length > 0 && (
        <div className="prompt-fields">
          {fields.map((f) => (
            <label key={f}>
              <span>{f}</span>
              <LazyInput value={values[f] ?? ""} readOnly={readOnly} onCommit={(v) => updateAttributes({ values: { ...node.attrs.values, [f]: v } })} />
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

function PromptView(props: NodeViewProps) {
  return props.node.attrs.template && !props.node.attrs.raw ? <PromptTemplateView {...props} /> : <PromptBuilder {...props} />;
}

export const PromptBlock = Node.create({
  name: "promptBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      collapsed: { default: false, parseHTML: (el) => el.getAttribute("data-collapsed") === "true", renderHTML: (a) => (a.collapsed ? { "data-collapsed": "true" } : {}) },
      title: { default: "", parseHTML: (el) => el.getAttribute("data-title") ?? "" },
      template: { default: "", parseHTML: (el) => el.getAttribute("data-template") ?? el.textContent ?? "" },
      raw: { default: "", parseHTML: (el) => el.getAttribute("data-raw") ?? "" },
      mode: { default: "refine", parseHTML: (el) => el.getAttribute("data-mode") ?? "refine" },
      output: { default: "", parseHTML: (el) => el.getAttribute("data-output") ?? "" },
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
    return ["div", mergeAttributes(HTMLAttributes, { "data-prompt-block": "", "data-title": a.title, "data-template": a.template, "data-values": JSON.stringify(a.values), "data-raw": a.raw, "data-mode": a.mode, "data-output": a.output }), a.output || a.template || a.raw];
  },
  // Copied, searched and counted as the template itself.
  renderText({ node }) {
    return [node.attrs.title, node.attrs.template, node.attrs.raw, node.attrs.output].filter(Boolean).join("\n");
  },
  addNodeView() {
    return ReactNodeViewRenderer(PromptView);
  },
});

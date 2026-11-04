import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import "katex/dist/katex.min.css";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { askAi, AiUnavailableError } from "../ai/client";
import { cleanLatex, latexToPlain } from "../lib/latex";
import { evaluate, formatAnswer, variablesIn } from "../lib/mathEval";
import { showError, showToast } from "../lib/toast";

/**
 * A math block: an equation written in LaTeX (typed, or handwritten and read by the AI), drawn
 * properly. Like Apple's Math Notes it calculates: "r = 3" defines r for everything below it (math
 * blocks and "=" in the text), and an expression shows its value.
 */

const SYSTEM =
  "You read handwritten mathematics from an image. Reply with the LaTeX for exactly what is written, nothing else: " +
  "no $ signs, no code fences, no explanation. Keep variable names as written (single letters stay single letters). " +
  "Use \\frac, \\sqrt, ^{}, _{}, \\cdot and \\times as appropriate. If several lines are written, join them with \\\\.";

function render(latex: string): { html: string; ok: boolean } {
  try {
    return { html: katex.renderToString(latex || "\\square", { displayMode: true, throwOnError: true, strict: "ignore" }), ok: true };
  } catch {
    return { html: katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: "ignore" }), ok: false };
  }
}

/** What the block works out to with the variables above it: "= 12", or "A = 28.27" for a definition. */
function resultOf(props: NodeViewProps, latex: string): string | null {
  const pos = typeof props.getPos === "function" ? props.getPos() : undefined;
  if (pos === undefined || !latex.trim()) return null;
  const lines: string[] = [];
  props.editor.state.doc.nodesBetween(0, pos, (n) => {
    if (n.type.name === "mathBlock") lines.push(latexToPlain(String(n.attrs.latex ?? "")));
    else if (n.isTextblock) {
      if (n.type.name !== "codeBlock" && n.textContent.includes("=")) lines.push(n.textContent);
      return false;
    }
    return true;
  });
  const vars = variablesIn(lines);
  const plain = latexToPlain(latex);
  const parts = plain.split("=");
  if (parts.length >= 2 && /^\s*[A-Za-zπ_][A-Za-z0-9_]*\s*$/.test(parts[0])) {
    const v = evaluate(parts[parts.length - 1], vars);
    return v === null ? null : `${parts[0].trim()} = ${formatAnswer(v)}`;
  }
  const v = evaluate(parts[0], vars);
  return v === null ? null : `= ${formatAnswer(v)}`;
}

/** A drawing pad: write the equation with a finger, pen or mouse; the AI turns it into LaTeX. */
function HandwritingPad({ onLatex, onClose }: { onLatex: (latex: string) => void; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<[number, number][][]>([]);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const draw = () => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 3 * (window.devicePixelRatio || 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes.current) {
      ctx.beginPath();
      s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
      ctx.stroke();
    }
  };
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const k = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * k);
    c.height = Math.round(r.height * k);
    draw();
  }, []);
  const point = (e: React.PointerEvent): [number, number] => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height];
  };
  const convert = async () => {
    const c = canvas.current;
    if (!c || !strokes.current.length) return;
    setBusy(true);
    try {
      const data = c.toDataURL("image/png").split(",")[1];
      const answer = await askAi({ task: "describe", cloud: true, system: SYSTEM, text: "Convert this handwritten maths to LaTeX.", images: [{ mime: "image/png", data }], maxTokens: 400 });
      const latex = cleanLatex(answer.text);
      if (!latex) throw new Error("The AI didn't read anything; try writing a little bigger.");
      onLatex(latex);
    } catch (e) {
      if (e instanceof AiUnavailableError) showToast("Handwriting needs AI: turn it on in Settings → AI (Gemini key).");
      else showError("Couldn't read the handwriting", e);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <>
      <div className="search-backdrop" onClick={onClose} />
      <div className="confirm-card handwriting-pad" role="dialog" aria-label="Write an equation">
        <h2>✍️ Write the equation</h2>
        <canvas
          ref={canvas}
          className="handwriting-canvas"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            strokes.current.push([point(e)]);
            draw();
          }}
          onPointerMove={(e) => {
            const s = strokes.current[strokes.current.length - 1];
            if (!s || !(e.buttons & 1) && e.pointerType === "mouse") return;
            if (e.currentTarget.hasPointerCapture?.(e.pointerId) === false) return;
            s.push(point(e));
            draw();
          }}
          onPointerUp={() => setCount(strokes.current.length)}
        />
        <p className="hint">Write as on paper. The picture goes to your AI (Gemini) to be read; nothing else from the note is sent.</p>
        <div className="confirm-actions">
          <button type="button" disabled={!count} onClick={() => (strokes.current.pop(), setCount(strokes.current.length), draw())}>↶ Undo</button>
          <button type="button" disabled={!count} onClick={() => ((strokes.current = []), setCount(0), draw())}>Clear</button>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!count || busy} onClick={() => void convert()}>{busy ? "Reading…" : "To LaTeX"}</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

function MathView(props: NodeViewProps) {
  const latex = String(props.node.attrs.latex ?? "");
  const [editing, setEditing] = useState(!latex);
  const [draft, setDraft] = useState(latex);
  const [pad, setPad] = useState(false);
  useEffect(() => setDraft(latex), [latex]);
  const shown = editing ? draft : latex;
  const { html, ok } = useMemo(() => render(shown), [shown]);
  // Recalculated whenever the note changes (a variable above may have).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    props.editor.on("update", f);
    return () => void props.editor.off("update", f);
  }, [props.editor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => resultOf(props, shown), [shown, tick]);
  const commit = (v: string) => {
    if (v !== latex) props.updateAttributes({ latex: v });
  };
  return (
    <NodeViewWrapper className={`math-block${props.selected ? " selected" : ""}`} data-drag-handle="">
      <div className="math-render" onClick={() => props.editor.isEditable && setEditing(true)} dangerouslySetInnerHTML={{ __html: html }} />
      {result && <div className="math-result">{result}</div>}
      {editing && (
        <div className="math-edit">
          <textarea
            value={draft}
            autoFocus={!latex}
            rows={Math.min(6, Math.max(1, draft.split("\n").length))}
            placeholder="LaTeX, e.g. A = \pi r^{2}"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commit(draft);
                setEditing(false);
              }
              if (e.key === "Escape") {
                setDraft(latex);
                setEditing(false);
              }
            }}
          />
          <div className="math-tools">
            {!ok && <span className="math-error">Not valid LaTeX yet</span>}
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setPad(true)}>✍️ Write</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => (commit(draft), setEditing(false))}>Done</button>
          </div>
        </div>
      )}
      {pad && (
        <HandwritingPad
          onClose={() => setPad(false)}
          onLatex={(l) => {
            setPad(false);
            setDraft(l);
            props.updateAttributes({ latex: l });
            setEditing(true);
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { latex: { default: "", parseHTML: (el) => el.getAttribute("data-latex") ?? el.textContent ?? "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-math-block]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-math-block": "", "data-latex": node.attrs.latex }), node.attrs.latex];
  },
  renderText({ node }) {
    return String(node.attrs.latex ?? "");
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },
});

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import "katex/dist/katex.min.css";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { askAi, AiUnavailableError } from "../ai/client";
import { blockLines, cleanLatex } from "../lib/latex";
import { conflictsIn, definitionsIn, formatAnswer, namesIn, type Definition, type Vars } from "../lib/mathEval";
import { displayLatex, FORMULAS, looksLikeLatex, niceRange, workingFor } from "../lib/mathSmart";
import { showError, showToast } from "../lib/toast";
import { copyText } from "./codeBlock";
import { CONTROL_KINDS, VariableControl, type ControlKind } from "./math/MathControls";
import { MathPlot } from "./math/MathPlot";

/**
 * A math block: an equation in plain maths ("(a+b+c+d)/2") or LaTeX, typed, picked from the
 * formula library, handwritten (read by the AI) or worked out by the AI from a question in words.
 * Like Apple's Math Notes it calculates: "r = 3" (also in a sentence: "the radius (r = 3)") defines
 * r for everything below it, and the block shows its value, the working step by step, the
 * variables it uses (with a warning when one was given two values), a slider / wheel / tumbler for
 * each, and a chart.
 */

const SYSTEM =
  "You read handwritten mathematics from an image. Reply with the LaTeX for exactly what is written, nothing else: " +
  "no $ signs, no code fences, no explanation. Keep variable names as written (single letters stay single letters). " +
  "Use \\frac, \\sqrt, ^{}, _{}, \\cdot and \\times as appropriate. If several lines are written, join them with \\\\.";

const SOLVE_SYSTEM =
  "You are a careful maths tutor inside a journal app. The user describes a problem or asks for a formula in plain words. " +
  "Work it out exactly and check the arithmetic. Reply in JSON. " +
  "'variables': each known quantity as a short name (one letter, or letter_subscript like v_0), its number and what it means (with unit). " +
  "'formula': the formula that gives the answer in PLAIN calculator syntax using only those names, numbers, + - * / ^ ( ) and sqrt(), sin(), cos(), tan(), ln(), log(), abs(), pi; " +
  "written as 'name = expression' (e.g. 's = u*t + 1/2*a*t^2'); empty if the problem has no single formula. " +
  "'steps': the working, one short line per step, plain text maths (no LaTeX). 'answer': the final answer with its unit, one line.";

const SOLVE_SCHEMA = {
  type: "object",
  properties: {
    variables: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "number" }, meaning: { type: "string" } }, required: ["name", "value", "meaning"] } },
    formula: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    answer: { type: "string" },
  },
  required: ["variables", "formula", "steps", "answer"],
};

interface Solution {
  prompt: string;
  steps: string[];
  answer: string;
}

const parseJson = <T,>(s: unknown, fallback: T): T => {
  try {
    return typeof s === "string" && s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function render(src: string): { html: string; ok: boolean } {
  let latex = displayLatex(src);
  // Several plain lines: one under the other, centred.
  if (!looksLikeLatex(src) && latex.includes("\\\\")) latex = `\\begin{gathered}${latex}\\end{gathered}`;
  try {
    return { html: katex.renderToString(latex || "\\square", { displayMode: true, throwOnError: true, strict: "ignore" }), ok: true };
  } catch {
    return { html: katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: "ignore" }), ok: false };
  }
}

/** The plain maths lines (as the calculator reads them) above the block, in order. */
function linesAbove(props: NodeViewProps): string[] {
  const pos = typeof props.getPos === "function" ? props.getPos() : undefined;
  const lines: string[] = [];
  if (pos === undefined) return lines;
  props.editor.state.doc.nodesBetween(0, pos, (n) => {
    if (n.type.name === "mathBlock") lines.push(...blockLines(String(n.attrs.latex ?? "")));
    else if (n.isTextblock) {
      if (n.type.name !== "codeBlock" && n.textContent.includes("=")) lines.push(n.textContent);
      return false;
    }
    return true;
  });
  return lines;
}

interface Worked {
  /** All definitions above and in the block. */
  defs: Definition[];
  conflicts: Map<string, Definition[]>;
  /** Values from the note (before any hand tweak). */
  vars: Vars;
  /** The last line: the one that's worked out. */
  target: string;
  /** The name it defines ("A" in "A = pi*r^2"), if any. */
  lhs: string | null;
  expr: string;
  used: string[];
  missing: string[];
}

function work(above: string[], src: string): Worked {
  const plain = blockLines(src);
  const target = plain[plain.length - 1] ?? "";
  const defs = definitionsIn([...above, ...plain.slice(0, -1)]);
  const vars: Vars = new Map();
  for (const d of defs) vars.set(d.name, d.value);
  const parts = target.split("=");
  const lhs = parts.length >= 2 && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(parts[0]) ? parts[0].trim() : null;
  const expr = (lhs ? parts[1] : parts[0]) ?? "";
  const used = namesIn(expr).filter((n) => n !== lhs);
  // The block's own result counts as a definition too (for conflicts with ones above).
  const own = lhs ? workingFor(target, vars) : null;
  const all = own && lhs ? [...defs, { name: lhs, value: Number(own.answer.split("=").pop()), line: above.length + plain.length - 1 }] : defs;
  return { defs, conflicts: conflictsIn(all.filter((d) => Number.isFinite(d.value))), vars, target, lhs, expr, used, missing: used.filter((n) => !vars.has(n)) };
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

/** Ready formulas, by group: a tap puts one in the block. */
function FormulaLibrary({ onPick, onClose }: { onPick: (plain: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = FORMULAS.filter((f) => !q || `${f.name} ${f.group} ${f.vars}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(list.map((f) => f.group))];
  return createPortal(
    <>
      <div className="search-backdrop" onClick={onClose} />
      <div className="confirm-card math-library" role="dialog" aria-label="Formulas">
        <h2>📚 Formulas</h2>
        <input className="math-library-search" placeholder="Search: circle, EMI, friction…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="math-library-list">
          {groups.map((g) => (
            <section key={g}>
              <h3>{g}</h3>
              <div className="math-library-grid">
                {list.filter((f) => f.group === g).map((f) => (
                  <button key={f.name} type="button" className="math-library-item" onClick={() => onPick(f.plain)}>
                    <span className="mli-name">{f.name}</span>
                    <span className="mli-tex" dangerouslySetInnerHTML={{ __html: render(f.plain).html }} />
                    <small>{f.vars}</small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="confirm-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Ask in words; the AI (Gemini) gives the variables, the formula, the working and the answer. */
function AskMath({ start, onAnswer, onClose }: { start: string; onAnswer: (source: string, solution: Solution) => void; onClose: () => void }) {
  const [q, setQ] = useState(start);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const a = await askAi<{ variables: { name: string; value: number; meaning: string }[]; formula: string; steps: string[]; answer: string }>({
        task: "organise",
        cloud: true,
        system: SOLVE_SYSTEM,
        text: q.trim(),
        schema: SOLVE_SCHEMA,
        maxTokens: 3000,
      });
      const j = a.json;
      const clean = (s: string) => s.replace(/[\u00d7\u00b7]/g, "*").replace(/[\u2212]/g, "-").replace(/\$/g, "").trim();
      const vars = (j.variables ?? []).filter((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name) && Number.isFinite(v.value));
      const lines = vars.map((v) => `${v.name} = ${formatAnswer(v.value)}`);
      const formula = clean(j.formula ?? "");
      if (formula) lines.push(formula);
      onAnswer(lines.join("\n"), { prompt: q.trim(), steps: [...vars.map((v) => `${v.name} = ${formatAnswer(v.value)}: ${v.meaning}`), ...(j.steps ?? [])], answer: j.answer ?? "" });
    } catch (e) {
      if (e instanceof AiUnavailableError) showToast("The math assistant needs AI: turn it on in Settings → AI (Gemini key).");
      else showError("The math assistant couldn't answer", e);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <>
      <div className="search-backdrop" onClick={onClose} />
      <div className="confirm-card math-ask" role="dialog" aria-label="Ask the math assistant">
        <h2>🤖 Math assistant</h2>
        <textarea
          rows={4}
          value={q}
          autoFocus
          placeholder="e.g. A car starts at 0 and speeds up at 3 m/s² for 8 s. How far does it go?  ·  Formula for the EMI of a ₹5 lakh loan at 9% for 3 years"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void ask()}
        />
        <p className="hint">Only this question goes to your AI (Gemini). The answer comes back as variables you can turn, a formula, the working and the answer.</p>
        <div className="confirm-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!q.trim() || busy} onClick={() => void ask()}>{busy ? "Working it out…" : "Solve"}</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** A read-only box with a copy button. */
function CopyBox({ title, text, multiline }: { title: string; text: string; multiline?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="math-copy">
      <div className="math-copy-head">
        <span>{title}</span>
        <button
          type="button"
          onClick={() =>
            void copyText(text)
              .then(() => (setDone(true), window.setTimeout(() => setDone(false), 1400)))
              .catch((e) => showError("Couldn't copy", e))
          }
        >
          {done ? "✓ Copied" : "⧉ Copy"}
        </button>
      </div>
      {multiline ? <ol>{text.split("\n").map((l, i) => <li key={i}>{l}</li>)}</ol> : <p>{text}</p>}
    </div>
  );
}

function MathView(props: NodeViewProps) {
  const latex = String(props.node.attrs.latex ?? "");
  const control = (String(props.node.attrs.control || "slider") as ControlKind);
  const plotName = String(props.node.attrs.plot ?? "");
  const savedTweaks = useMemo(() => parseJson<Record<string, number>>(props.node.attrs.tweaks, {}), [props.node.attrs.tweaks]);
  const solution = useMemo(() => parseJson<Solution | null>(props.node.attrs.solution, null), [props.node.attrs.solution]);
  const [editing, setEditing] = useState(!latex);
  const [draft, setDraft] = useState(latex);
  const [panel, setPanel] = useState<null | "pad" | "library" | "ask">(null);
  const [open, setOpen] = useState<null | "controls" | "work" | "plot">(null);
  // Hand tweaks are live while turning; they're saved in the note a moment after the hand stops.
  const [tweaks, setTweaks] = useState(savedTweaks);
  useEffect(() => setTweaks(savedTweaks), [savedTweaks]);
  const saveTimer = useRef(0);
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
  const w = useMemo(() => work(linesAbove(props), shown), [shown, tick]);
  const live: Vars = useMemo(() => {
    const v = new Map(w.vars);
    for (const [k, x] of Object.entries(tweaks)) if (w.used.includes(k) && Number.isFinite(x)) v.set(k, x);
    return v;
  }, [w, tweaks]);
  const worked = useMemo(() => (w.target ? workingFor(w.target, live) : null), [w, live]);
  const tweaked = Object.keys(tweaks).some((k) => w.used.includes(k) && tweaks[k] !== w.vars.get(k));
  const commit = (v: string) => {
    if (v !== latex) props.updateAttributes({ latex: v });
  };
  const setTweak = (name: string, value: number) => {
    const next = { ...tweaks };
    if (value === w.vars.get(name)) delete next[name];
    else next[name] = value;
    setTweaks(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => props.updateAttributes({ tweaks: Object.keys(next).length ? JSON.stringify(next) : "" }), 700);
  };
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);
  // What to plot against: the chosen name, else the first one without a value, else the first used.
  const plotVar = (plotName && w.used.includes(plotName) ? plotName : w.missing[0] ?? w.used[0]) || "";
  const plotAt = live.get(plotVar);
  const [plotFrom, plotTo] = plotAt !== undefined ? niceRange(w.vars.get(plotVar) ?? plotAt) : [-10, 10];
  const conflictText = [...w.conflicts].map(([n, list]) => `${n} is set to ${[...new Set(list.map((d) => formatAnswer(d.value)))].join(" and ")}`).join("; ");
  const steps = worked?.steps ?? [];
  const tool = (label: string, onClick: () => void, on = false, title?: string) => (
    <button type="button" className={on ? "on" : ""} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  return (
    <NodeViewWrapper className={`math-block${props.selected ? " selected" : ""}`} data-drag-handle="">
      <div className="math-render" onClick={() => props.editor.isEditable && setEditing(true)} dangerouslySetInnerHTML={{ __html: html }} />
      {(w.used.length > 0 || w.conflicts.size > 0) && (
        <div className="math-vars">
          <span className="math-var-count" title={`${w.defs.length} definitions in this note above`}>
            {w.used.length} variable{w.used.length === 1 ? "" : "s"}
          </span>
          {w.used.map((n) => (
            <span key={n} className={`math-var${live.has(n) ? "" : " missing"}${w.conflicts.has(n) ? " clash" : ""}`} title={w.defs.filter((d) => d.name === n).map((d) => d.label ?? "").filter(Boolean).join(", ") || undefined}>
              {n}
              {live.has(n) ? ` = ${formatAnswer(live.get(n)!)}` : " = ?"}
            </span>
          ))}
          {w.conflicts.size > 0 && <span className="math-warn" role="alert">⚠ {conflictText}: the latest is used</span>}
        </div>
      )}
      {worked && <div className="math-result">{worked.answer.startsWith(`${w.lhs} =`) ? worked.answer : `= ${worked.answer}`}{tweaked && <small> (turned)</small>}</div>}
      {open === "controls" && (
        <div className="math-controls">
          <div className="math-control-kinds" role="radiogroup" aria-label="Control">
            {CONTROL_KINDS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={control === k.id} className={control === k.id ? "on" : ""} onClick={() => props.updateAttributes({ control: k.id })}>
                {k.icon} {k.label}
              </button>
            ))}
          </div>
          {w.used.filter((n) => live.has(n)).map((n) => (
            <VariableControl key={n} kind={control} name={n} label={w.defs.filter((d) => d.name === n).pop()?.label} value={live.get(n)!} base={w.vars.get(n) ?? live.get(n)!} onChange={(v) => setTweak(n, v)} />
          ))}
          {w.missing.length > 0 && <p className="hint">{w.missing.join(", ")} {w.missing.length === 1 ? "has" : "have"} no value yet: write "{w.missing[0]} = 5" above (or in a sentence, "the speed (v = 5)").</p>}
          {!w.used.length && <p className="hint">This formula has no variables to turn.</p>}
        </div>
      )}
      {open === "work" && (
        <div className="math-work">
          {solution && <p className="math-question">❓ {solution.prompt}</p>}
          {(solution?.steps.length || steps.length > 1) && <CopyBox title="Working" text={(solution?.steps.length ? solution.steps : steps).join("\n")} multiline />}
          {(solution?.answer || worked) && <CopyBox title="Answer" text={solution?.answer && !tweaked ? solution.answer : worked?.answer ?? solution?.answer ?? ""} />}
          {!solution && !worked && <p className="hint">Nothing to work out yet{w.missing.length ? `: ${w.missing.join(", ")} need${w.missing.length === 1 ? "s" : ""} a value` : ""}.</p>}
        </div>
      )}
      {open === "plot" && plotVar && (
        <div className="math-plot-wrap">
          {w.used.length > 1 && (
            <div className="math-control-kinds" role="radiogroup" aria-label="Plot against">
              {w.used.map((n) => (
                <button key={n} type="button" role="radio" aria-checked={plotVar === n} className={plotVar === n ? "on" : ""} onClick={() => props.updateAttributes({ plot: n })}>{n}</button>
              ))}
            </div>
          )}
          <MathPlot expr={w.expr} vars={live} name={plotVar} from={plotFrom} to={plotTo} at={plotAt} yName={w.lhs ?? "Value"} />
        </div>
      )}
      {open === "plot" && !plotVar && <p className="hint">Add a variable (like x) to draw a chart.</p>}
      <div className="math-bar">
        {tool("🎚️", () => setOpen(open === "controls" ? null : "controls"), open === "controls", "Turn the variables")}
        {tool("🧮", () => setOpen(open === "work" ? null : "work"), open === "work", "Working and answer, to copy")}
        {tool("📈", () => setOpen(open === "plot" ? null : "plot"), open === "plot", "Chart")}
        {tool("📚", () => setPanel("library"), false, "Formulas")}
        {tool("🤖", () => setPanel("ask"), false, "Ask the math assistant")}
        {!editing && tool("✏️", () => setEditing(true), false, "Edit")}
      </div>
      {editing && (
        <div className="math-edit">
          <textarea
            value={draft}
            autoFocus={!latex}
            rows={Math.min(6, Math.max(1, draft.split("\n").length))}
            placeholder="Plain maths, e.g. A = pi*r^2 or (a+b+c+d)/2 (LaTeX works too)"
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
            {!ok && <span className="math-error">Can't draw this yet</span>}
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setPanel("pad")}>✍️ Write</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => (commit(draft), setEditing(false))}>Done</button>
          </div>
        </div>
      )}
      {panel === "pad" && (
        <HandwritingPad
          onClose={() => setPanel(null)}
          onLatex={(l) => {
            setPanel(null);
            setDraft(l);
            props.updateAttributes({ latex: l });
            setEditing(true);
          }}
        />
      )}
      {panel === "library" && (
        <FormulaLibrary
          onClose={() => setPanel(null)}
          onPick={(plain) => {
            setPanel(null);
            setDraft(plain);
            props.updateAttributes({ latex: plain, tweaks: "", solution: "" });
            setEditing(false);
            setOpen("controls");
          }}
        />
      )}
      {panel === "ask" && (
        <AskMath
          start={solution?.prompt ?? ""}
          onClose={() => setPanel(null)}
          onAnswer={(source, sol) => {
            setPanel(null);
            setDraft(source);
            props.updateAttributes({ latex: source, tweaks: "", solution: JSON.stringify(sol) });
            setEditing(false);
            setOpen("work");
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

const ATTRS = ["tweaks", "control", "plot", "solution"] as const;

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      latex: { default: "", parseHTML: (el) => el.getAttribute("data-latex") ?? el.textContent ?? "" },
      // Hand-turned values (JSON), the kind of control, the variable the chart runs over, the AI's working (JSON).
      ...Object.fromEntries(ATTRS.map((a) => [a, { default: "", parseHTML: (el: HTMLElement) => el.getAttribute(`data-${a}`) ?? "", renderHTML: (attrs: Record<string, unknown>) => (attrs[a] ? { [`data-${a}`]: attrs[a] } : {}) }])),
    };
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

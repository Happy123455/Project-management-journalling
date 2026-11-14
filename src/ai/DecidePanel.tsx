import { useEffect, useState } from "react";
import type { JournalStore } from "../store";
import { decide, DECIDE_MODELS, loadConfigs, newQuestion, NODE_PLACEMENT, saveConfigs, type DecisionConfig, type Question, type Verdict } from "./decide";
import { showError, showToast } from "../lib/toast";

/**
 * ⚖️ Decision models in AI chat: small, cheap Gemini judgements, set up in three parts.
 * Input settings (what goes in and how), the evaluation schema (the questions and their types),
 * and scoring and thresholds (when an answer passes, how sure it must be). Saved to the page
 * "AI decision models", so they sync. "Graph node placement" is the one voice graphs use.
 */

const MAX_QUESTIONS = 10;
const MAX_MEDIA = 8 * 1024 * 1024;

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const keyOf = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32) || "q";

function readMedia(file: File): Promise<{ mime: string; data: string }> {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok({ mime: file.type || "application/octet-stream", data: String(r.result).split(",")[1] ?? "" });
    r.onerror = () => bad(r.error ?? new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

function QuestionEdit({ q, onChange, onRemove, placement }: { q: Question; onChange: (q: Question) => void; onRemove?: () => void; placement: boolean }) {
  const set = (p: Partial<Question>) => onChange({ ...q, ...p });
  const fixed = placement && q.key === "branch";
  return (
    <div className="dc-q">
      <div className="dc-row">
        <input value={q.key} onChange={(e) => set({ key: keyOf(e.target.value) })} aria-label="Key" disabled={fixed} className="dc-key" />
        <select value={q.type} onChange={(e) => {
            const type = e.target.value as Question["type"];
            // Sensible starting thresholds for the new type.
            set(type === "score" ? { type, min: q.min ?? 1, max: q.max ?? 5, pass: q.pass ?? 3 } : type === "bool" ? { type, expect: q.expect ?? true } : { type, options: q.options ?? [], accept: q.accept ?? [] });
          }} aria-label="Type" disabled={fixed}>
          <option value="bool">Yes / no</option>
          <option value="choice">Choice</option>
          <option value="score">Score</option>
        </select>
        {onRemove && !fixed && (
          <button type="button" onClick={onRemove} aria-label="Remove question">✕</button>
        )}
      </div>
      <textarea value={q.instruction} rows={2} placeholder="What to judge, in plain words" onChange={(e) => set({ instruction: e.target.value })} aria-label="Instruction" />
      {q.type === "choice" &&
        (fixed ? (
          <p className="hint">Options: the graph's branches, plus "new". Filled in each time.</p>
        ) : (
          <input value={(q.options ?? []).join(", ")} placeholder="Options, comma separated" onChange={(e) => set({ options: list(e.target.value) })} aria-label="Options" />
        ))}
      {q.type === "score" && (
        <div className="dc-row">
          <label>
            From <input type="number" value={q.min ?? 1} onChange={(e) => set({ min: Number(e.target.value) })} />
          </label>
          <label>
            to <input type="number" value={q.max ?? 5} onChange={(e) => set({ max: Number(e.target.value) })} />
          </label>
          <input value={q.rubric ?? ""} placeholder="Rubric: 1 = …, 5 = …" onChange={(e) => set({ rubric: e.target.value })} aria-label="Rubric" />
        </div>
      )}
    </div>
  );
}

function Threshold({ q, onChange, placement }: { q: Question; onChange: (q: Question) => void; placement: boolean }) {
  const set = (p: Partial<Question>) => onChange({ ...q, ...p });
  return (
    <div className="dc-row">
      <span className="dc-tkey">{q.key}</span>
      {q.type === "bool" && (
        <select value={q.expect === false ? "no" : "yes"} onChange={(e) => set({ expect: e.target.value === "yes" })} aria-label={`${q.key} passes when`}>
          <option value="yes">passes on yes</option>
          <option value="no">passes on no</option>
        </select>
      )}
      {q.type === "choice" &&
        (placement && q.key === "branch" ? (
          <span className="hint">passes on any existing branch</span>
        ) : (
          <input value={(q.accept ?? []).join(", ")} placeholder="Passing options (empty: any)" onChange={(e) => set({ accept: list(e.target.value) })} aria-label={`${q.key} passing options`} />
        ))}
      {q.type === "score" && (
        <label>
          passes at ≥ <input type="number" value={q.pass ?? q.min ?? 1} min={q.min ?? 1} max={q.max ?? 5} onChange={(e) => set({ pass: Number(e.target.value) })} />
        </label>
      )}
    </div>
  );
}

export function DecidePanel({ store, onClose }: { store: JournalStore; onClose: () => void }) {
  const [configs, setConfigs] = useState<DecisionConfig[]>([NODE_PLACEMENT]);
  const [id, setId] = useState(NODE_PLACEMENT.id);
  const [dirty, setDirty] = useState(false);
  const [tryText, setTryText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Verdict | null>(null);

  useEffect(() => {
    let live = true;
    void loadConfigs(store).then((l) => live && setConfigs(l));
    return () => {
      live = false;
    };
  }, [store]);

  const c = configs.find((x) => x.id === id) ?? configs[0];
  const placement = c.id === NODE_PLACEMENT.id;
  const edit = (next: DecisionConfig) => {
    setConfigs(configs.map((x) => (x.id === c.id ? next : x)));
    setDirty(true);
    setResult(null);
  };
  const input = (p: Partial<DecisionConfig["input"]>) => edit({ ...c, input: { ...c.input, ...p } });
  const setQuestion = (i: number, q: Question) => {
    const qs = c.questions.slice();
    // Keys stay unique: the answer schema is keyed by them.
    const taken = new Set(qs.filter((_, j) => j !== i).map((x) => x.key));
    let key = q.key;
    for (let n = 2; taken.has(key); n++) key = `${q.key}_${n}`;
    qs[i] = { ...q, key };
    edit({ ...c, questions: qs });
  };
  const setCount = (n: number) => {
    const count = Math.max(1, Math.min(MAX_QUESTIONS, Math.round(n) || 1));
    const qs = c.questions.slice(0, count);
    for (let k = qs.length; k < count; k++) {
      let j = k + 1;
      while (qs.some((q) => q.key === `q${j}`)) j++;
      qs.push(newQuestion(j));
    }
    if (placement && !qs.some((q) => q.key === "branch")) qs.unshift(NODE_PLACEMENT.questions[0]);
    edit({ ...c, questions: qs });
  };

  // Closing saves too, so a tuned model is never lost.
  const save = async () => {
    try {
      await saveConfigs(store, configs);
      setDirty(false);
      showToast("Decision models saved", "info");
    } catch (e) {
      showError("Couldn't save the decision models", e);
    }
  };
  const add = () => {
    const fresh: DecisionConfig = {
      id: `dm-${Date.now().toString(36)}`,
      name: "New decision",
      input: { content: "text", delivery: "inline", mediaResolution: "low", model: DECIDE_MODELS[0] },
      questions: [newQuestion(1)],
      scoring: { mode: "all", minConfidence: 0.6 },
    };
    setConfigs([...configs, fresh]);
    setId(fresh.id);
    setDirty(true);
    setResult(null);
  };
  const remove = () => {
    if (placement) {
      // The built-in one can't go: back to its defaults.
      edit(NODE_PLACEMENT);
      return;
    }
    setConfigs(configs.filter((x) => x.id !== c.id));
    setId(NODE_PLACEMENT.id);
    setDirty(true);
    setResult(null);
  };
  const run = async () => {
    if (busy) return;
    if (file && file.size > MAX_MEDIA) return showToast("That file is over 8 MB", "error");
    const tryConfig = placement
      ? { ...c, questions: c.questions.map((q) => (q.key === "branch" ? { ...q, options: list(tryText.split("\n")[0] ?? ""), accept: [] } : q)) }
      : c;
    setBusy(true);
    setResult(null);
    try {
      const media = file ? [await readMedia(file)] : [];
      setResult(await decide(tryConfig, { text: placement ? tryText.split("\n").slice(1).join("\n") : tryText, media }));
    } catch (e) {
      showError("Couldn't judge it", e);
    } finally {
      setBusy(false);
    }
  };

  const wantsMedia = c.input.content !== "text";
  return (
    <div className="ai-section dc">
      <div className="ai-chat-bar">
        <select value={c.id} onChange={(e) => (setId(e.target.value), setResult(null))} aria-label="Decision model">
          {configs.map((x) => (
            <option key={x.id} value={x.id}>
              ⚖️ {x.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={add} title="New decision model">＋</button>
        <button type="button" onClick={() => (dirty ? void save().then(onClose) : onClose())} aria-label="Close">✕</button>
      </div>
      <div className="dc-body">
        <input className="dc-name" value={c.name} onChange={(e) => edit({ ...c, name: e.target.value.slice(0, 60) })} aria-label="Name" />

        <details className="dc-part" open>
          <summary>Input settings</summary>
          <div className="dc-grid">
            <label>
              Content
              <select value={c.input.content} onChange={(e) => input({ content: e.target.value as DecisionConfig["input"]["content"] })}>
                <option value="text">Text</option>
                <option value="text+image">Text + image</option>
                <option value="image">Image</option>
                <option value="audio">Audio</option>
              </select>
            </label>
            <label>
              Delivery
              <select value={c.input.delivery} onChange={(e) => input({ delivery: e.target.value as DecisionConfig["input"]["delivery"] })}>
                <option value="inline">One at a time</option>
                <option value="batch">Batched (cheaper)</option>
              </select>
            </label>
            <label>
              Media resolution
              <select value={c.input.mediaResolution} onChange={(e) => input({ mediaResolution: e.target.value as DecisionConfig["input"]["mediaResolution"] })}>
                <option value="low">Low (fewest tokens)</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label>
              Model
              <select value={c.input.model} onChange={(e) => input({ model: e.target.value })}>
                {DECIDE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea value={c.input.instructions ?? ""} rows={2} placeholder="Instructions before the questions (optional)" onChange={(e) => input({ instructions: e.target.value })} aria-label="Instructions" />
        </details>

        <details className="dc-part" open>
          <summary>Evaluation schema</summary>
          <label className="dc-row">
            Questions
            <input type="number" min={1} max={MAX_QUESTIONS} value={c.questions.length} onChange={(e) => setCount(Number(e.target.value))} className="dc-count" />
          </label>
          {c.questions.map((q, i) => (
            <QuestionEdit
              key={i}
              q={q}
              placement={placement}
              onChange={(n) => setQuestion(i, n)}
              onRemove={c.questions.length > 1 ? () => edit({ ...c, questions: c.questions.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
        </details>

        <details className="dc-part" open>
          <summary>Scoring and thresholds</summary>
          <div className="dc-row">
            <select value={c.scoring.mode} onChange={(e) => edit({ ...c, scoring: { ...c.scoring, mode: e.target.value as "all" | "any" } })} aria-label="Verdict">
              <option value="all">Yes when every answer passes</option>
              <option value="any">Yes when any answer passes</option>
            </select>
          </div>
          {c.questions.map((q, i) => (
            <Threshold key={i} q={q} placement={placement} onChange={(n) => setQuestion(i, n)} />
          ))}
          <label className="dc-row">
            Confidence ≥ {c.scoring.minConfidence.toFixed(2)}
            <input type="range" min={0} max={1} step={0.05} value={c.scoring.minConfidence} onChange={(e) => edit({ ...c, scoring: { ...c.scoring, minConfidence: Number(e.target.value) } })} />
          </label>
          <p className="hint">Below this the verdict is "unsure"{placement ? " and the node gets its own branch" : ""}.</p>
        </details>

        <details className="dc-part">
          <summary>Try it</summary>
          <textarea
            value={tryText}
            rows={3}
            placeholder={placement ? "First line: branches, comma separated. Then the new line." : "Something to judge"}
            onChange={(e) => setTryText(e.target.value)}
            aria-label="Try text"
          />
          {wantsMedia && <input type="file" accept={c.input.content === "audio" ? "audio/*" : "image/*"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Attachment" />}
          <button type="button" disabled={busy || (!tryText.trim() && !file)} onClick={() => void run()}>
            {busy ? "Judging…" : "⚖️ Judge"}
          </button>
          {result && (
            <div className={`dc-result ${result.verdict}`}>
              <strong>{result.verdict === "yes" ? "✓ Yes" : result.verdict === "no" ? "✗ No" : "? Unsure"}</strong>
              {c.questions.map((q) => {
                const a = result.answers[q.key];
                return (
                  <div key={q.key} className="dc-row">
                    <span className="dc-tkey">{q.key}</span>
                    <span>{a ? String(a.value) : "—"}</span>
                    <span className="hint">{a ? `${Math.round(a.confidence * 100)}%` : ""}</span>
                    <span>{result.passed[q.key] ? "✓" : "✗"}</span>
                    {a?.why && <span className="hint dc-why">{a.why}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </details>
      </div>
      <div className="ai-summaries">
        <button type="button" disabled={!dirty} onClick={() => void save()}>💾 Save</button>
        <button type="button" onClick={remove}>{placement ? "↺ Defaults" : "🗑 Delete"}</button>
      </div>
    </div>
  );
}

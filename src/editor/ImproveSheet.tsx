// Item 6: the "✨ Improve" sheet. The original and the improved prompt side by side (one above
// the other on a phone), the new words underlined, a short note on what changed; Keep, Edit or
// Close. The caller applies a kept version as an AI edit and offers Undo.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { improvePrompt, wordDiff, type Improved } from "../ai/improve";
import { fx } from "../lib/fx";
import { useEscapeToClose } from "../ui/useEscapeToClose";

export function ImproveSheet({ original, title = "✨ Improve", onKeep, onClose }: { original: string; title?: string; onKeep: (text: string, by: Improved) => void; onClose: () => void }) {
  const [result, setResult] = useState<Improved | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [why, setWhy] = useState(false);
  const close = () => (fx("close"), onClose());
  useEscapeToClose(close);
  useEffect(() => {
    let live = true;
    improvePrompt(original)
      .then((r) => live && (setResult(r), setDraft(r.text), fx("done")))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [original]);
  const same = result && result.text.trim() === original.trim();
  return createPortal(
    <div className="dls-back" onClick={close}>
      <div className="dls dls-wide improve-sheet" role="dialog" aria-label="Improve the prompt" onClick={(e) => e.stopPropagation()}>
        <div className="dls-grip" />
        <header className="dls-head">
          <h3 className="improve-title">{title}</h3>
          <button type="button" className="dls-x" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="improve-cols">
          <section>
            <h4>Yours</h4>
            <p className="improve-text">{original}</p>
          </section>
          <section>
            <h4>Improved</h4>
            {!result && !error && <p className="improve-text improve-wait">Improving…</p>}
            {error && <p className="hint prompt-error">{error}</p>}
            {result && !editing && (
              <p className="improve-text">
                {wordDiff(original, result.text).map((p, i) => (p.kind === "new" ? <mark key={i} className="improve-new">{p.text}</mark> : <span key={i}>{p.text}</span>))}
              </p>
            )}
            {result && editing && <textarea className="improve-edit" value={draft} rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))} onChange={(e) => setDraft(e.target.value)} autoFocus />}
          </section>
        </div>
        {result && (result.note || result.added.length > 0) && (
          <div className="improve-why">
            <button type="button" className="link" aria-expanded={why} onClick={() => setWhy(!why)}>What changed and why {why ? "▴" : "▾"}</button>
            {why && (
              <>
                {result.note && <p>{result.note}</p>}
                {result.added.length > 0 && <p className="hint">Words added: {result.added.join(", ")}</p>}
              </>
            )}
          </div>
        )}
        <footer className="improve-actions">
          {result && <span className="hint">{same ? "Already reads well: nothing to change." : `By ${result.actor}`}</span>}
          <button type="button" onClick={close}>Close</button>
          {result && !editing && !same && <button type="button" onClick={() => (fx("open"), setEditing(true))}>Edit</button>}
          <button type="button" className="primary" disabled={!result || same || !draft.trim()} onClick={() => result && onKeep(editing ? draft : result.text, result)}>
            Keep
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

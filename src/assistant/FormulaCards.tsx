import { useMemo, useState } from "react";
import type { JournalStore } from "../store";
import { AI_OPEN_EVENT } from "../ai/journalTools";
import { appendBlocks } from "../lib/append";
import { formatAnswer } from "../lib/mathEval";
import { workOut, type FoundFormula } from "../lib/mathFind";
import { dayKey } from "../lib/timestamp";
import { showError, showToast } from "../lib/toast";
import { docText } from "../lib/words";

/**
 * Formulas the assistant found (math_find), as cards under its answer: each shows its answer, its
 * values (change one and it works it out again, right here, no AI), and Open / Add to today.
 */
export function FormulaCards({ store, cards, actor }: { store: JournalStore; cards: FoundFormula[]; actor: string }) {
  return (
    <ul className="cmd-formulas">
      {cards.slice(0, 12).map((f, i) => (
        <FormulaCard key={`${f.note}|${f.path.join(".")}|${i}`} store={store} f={f} n={i + 1} actor={actor} />
      ))}
    </ul>
  );
}

function FormulaCard({ store, f, n, actor }: { store: JournalStore; f: FoundFormula; n: number; actor: string }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(f.vars.map((v) => [v.name, v.value === null ? "" : formatAnswer(v.value)])));
  const nums = useMemo(() => Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim() !== "" && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])), [vals]);
  const w = useMemo(() => workOut([], f.target, {}, nums), [f.target, nums]);
  const changed = f.vars.some((v) => v.value !== null && nums[v.name] !== undefined && nums[v.name] !== v.value);
  const open = () => window.dispatchEvent(new CustomEvent(AI_OPEN_EVENT, { detail: { target: f.note, newTab: false, now: true } }));
  const addToday = async () => {
    try {
      const day = dayKey(new Date());
      await window.__journalFlush?.();
      const page = await store.getDay(day);
      const latex = [...w.vars.map((v) => `${v.name} = ${formatAnswer(v.value ?? 0)}`), f.target].join("\n");
      const doc = appendBlocks(page?.content ?? null, [{ type: "mathBlock", attrs: { latex } }, { type: "paragraph" }]);
      await store.saveDay({ day, content: doc, plainText: docText(doc), actor });
      window.dispatchEvent(new Event("journal:reload-page"));
      showToast("Added to today as a math block");
    } catch (e) {
      showError("Couldn't add it", e);
    }
  };
  return (
    <li className="cmd-formula">
      <div className="cf-head">
        <span className="cf-n">{n}</span>
        <code>{f.target}</code>
        {f.starred && <span title="Starred">⭐</span>}
      </div>
      {f.question && <p className="cf-q">❓ {f.question}</p>}
      {f.vars.length > 0 && (
        <div className="cf-vars">
          {f.vars.map((v) => (
            <label key={v.name} title={v.label}>
              {v.name} =
              <input inputMode="decimal" value={vals[v.name] ?? ""} placeholder="?" onChange={(e) => setVals({ ...vals, [v.name]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      <p className="cf-a">{w.answer ? `= ${w.answer.includes("=") ? w.answer.split("=").pop()!.trim() : w.answer}` : "needs a value"}{changed && <small> (new values)</small>}</p>
      <div className="cmd-actions">
        <span className="hint">{f.note}</span>
        {f.note !== "⭐ favourites" && <button type="button" className="link" onClick={open}>Open</button>}
        <button type="button" className="link" onClick={() => void addToday()}>＋ Today</button>
      </div>
    </li>
  );
}

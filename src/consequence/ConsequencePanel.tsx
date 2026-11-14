import { useEffect, useMemo, useState } from "react";
import type { JournalStore, NamedPage } from "../store";
import {
  rawSignals,
  similarFailed,
  situationMarkdown,
  situationStats,
  type Analysis,
  type CleanRec,
  type EngineData,
  type Entry,
  type Felt,
  type MoveRec,
  type Path,
  type RunRec,
} from "../lib/consequence";
import { addDays, dayKey } from "../lib/timestamp";
import { showError, showToast } from "../lib/toast";
import { copyText } from "../editor/codeBlock";
import {
  ENGINE_EVENT,
  answerQuestions,
  busy,
  cleanAll,
  clearJob,
  jobFor,
  loadChoice,
  loadClean,
  loadEngine,
  loadEntries,
  lockIn,
  logOutcome,
  pageTextOf,
  removeMove,
  saveChoice,
  saveChoiceGraph,
  startReading,
  stopReading,
  subscribeJobs,
  type DeepChoice,
} from "./engine";
import "./consequence.css";

/**
 * 🎲 The consequence engine on a project's or person's page: read the situation honestly, see the
 * next moves as a choice tree, lock one in, and log what really happened (the reality loop).
 * Closed, it only shows a line with what's waiting; nothing runs until Hapi taps.
 */

const CHOICES: { id: DeepChoice; label: string }[] = [
  { id: "auto", label: "Auto (Gemini, or the Mac's model)" },
  { id: "gemini", label: "Gemini Pro (whole history)" },
  { id: "claude", label: "Claude" },
  { id: "local", label: "Mac's model (private, slow)" },
];
const LOOK_BACK: { days: number; label: string }[] = [
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
];
const STYLE_ICON: Record<string, string> = { hold: "🛡️", strategic: "♟️", direct: "⚡", exit: "🚪" };
const FELT: { id: Felt; label: string }[] = [
  { id: "better", label: "🙂 Better than predicted" },
  { id: "as-expected", label: "😐 About as predicted" },
  { id: "worse", label: "🙁 Worse" },
];

const short = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// Drafts stay on this device until they're saved (never lose typed text).
const draftKey = (k: string) => `journal.ce-draft.${k}`;
function readDraft(k: string): string {
  try {
    return localStorage.getItem(draftKey(k)) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(k: string, v: string) {
  try {
    if (v) localStorage.setItem(draftKey(k), v);
    else localStorage.removeItem(draftKey(k));
  } catch {
    // Kept on screen only.
  }
}
function useDraft(k: string): [string, (v: string) => void] {
  const [v, setV] = useState(() => readDraft(k));
  useEffect(() => setV(readDraft(k)), [k]);
  return [v, (x: string) => (setV(x), writeDraft(k, x))];
}

function useJob(title: string) {
  const [job, setJob] = useState(() => jobFor(title));
  useEffect(() => {
    setJob(jobFor(title));
    return subscribeJobs(() => setJob(jobFor(title)));
  }, [title]);
  return job;
}

const tone = (n: number) => (n >= 70 ? "hot" : n >= 40 ? "warm" : "calm");

function Meter({ label, value, note, invert }: { label: string; value: number; note: string; invert?: boolean }) {
  const t = invert ? tone(100 - value) : tone(value);
  return (
    <div className={`ce-meter ce-${t}`}>
      <div className="ce-meter-head">
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <div className="ce-meter-bar" style={{ ["--v" as string]: `${value}%` }} />
      {note && <p>{note}</p>}
    </div>
  );
}

function Odds({ value }: { value: number }) {
  return (
    <span className="ce-odds" style={{ ["--v" as string]: `${value * 3.6}deg` }} title={`${value}% chance it moves things towards your goal`}>
      <span>{value}%</span>
    </span>
  );
}

function LockForm({ onLock, custom }: { onLock: (o: { action: string; days: number; remind: boolean }) => Promise<void>; custom?: { draft: string; setDraft: (v: string) => void } }) {
  const [days, setDays] = useState(7);
  const [remind, setRemind] = useState(true);
  const [saving, setSaving] = useState(false);
  return (
    <div className="ce-lock">
      {custom && (
        <textarea rows={2} value={custom.draft} placeholder="What are you doing instead?" onChange={(e) => custom.setDraft(e.target.value)} aria-label="Your own move" />
      )}
      <div className="ce-lock-row">
        <span>Look back in</span>
        {LOOK_BACK.map((l) => (
          <button key={l.days} type="button" className={days === l.days ? "on" : ""} onClick={() => setDays(l.days)}>
            {l.label}
          </button>
        ))}
      </div>
      <label className="ce-check">
        <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} /> Remind me that day (a line on {short(addDays(dayKey(new Date()), days))})
      </label>
      <button
        type="button"
        className="ce-primary"
        disabled={saving || (!!custom && !custom.draft.trim())}
        onClick={async () => {
          setSaving(true);
          try {
            await onLock({ action: custom?.draft ?? "", days, remind });
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Locking in…" : "🔒 Lock it in"}
      </button>
    </div>
  );
}

function PathCard({ p, best, warnings, onLock }: { p: Path; best: boolean; warnings: MoveRec[]; onLock: (o: { days: number; remind: boolean }) => Promise<void> }) {
  const [locking, setLocking] = useState(false);
  return (
    <article className={`ce-path ce-style-${p.style}${best ? " best" : ""}`}>
      <header>
        <span className="ce-letter">{p.id}</span>
        <div className="ce-path-title">
          <b>
            {STYLE_ICON[p.style] ?? "•"} {p.title}
          </b>
          <span className={`ce-risk ce-risk-${p.risk}`}>{p.risk} risk</span>
          {best && <span className="ce-best">★ the verdict</span>}
        </div>
        <Odds value={p.odds} />
      </header>
      <p className="ce-do">
        <b>Do:</b> {p.action}
      </p>
      <ol className="ce-chain">
        {p.immediate && (
          <li>
            <span>⚡ Right away</span>
            {p.immediate}
          </li>
        )}
        {p.counter && (
          <li>
            <span>↩︎ They react</span>
            {p.counter}
          </li>
        )}
        {p.months && (
          <li>
            <span>📅 3–6 months</span>
            {p.months}
          </li>
        )}
        {p.longRun && (
          <li>
            <span>🌳 Long run</span>
            {p.longRun}
          </li>
        )}
      </ol>
      {p.cost && <p className="ce-cost">Costs: {p.cost}</p>}
      {warnings.map((m) => (
        <p key={m.id} className="ce-loopwarn">
          ⚠ Like what you did on {short(m.day)} (“{m.action.slice(0, 90)}”), which went {m.outcome?.felt === "worse" ? "worse than predicted" : "badly"}.
        </p>
      ))}
      {locking ? (
        <LockForm onLock={async (o) => (await onLock(o), setLocking(false))} />
      ) : (
        <button type="button" className="ce-lockbtn" onClick={() => setLocking(true)}>
          🔒 Lock in this move
        </button>
      )}
    </article>
  );
}

function ChoiceTree({ a, moves, onLock }: { a: Analysis; moves: MoveRec[]; onLock: (p: Path, o: { days: number; remind: boolean }) => Promise<void> }) {
  return (
    <div className="ce-tree">
      <div className="ce-root">
        <span>📍 Now</span>
      </div>
      <div className="ce-branches" style={{ ["--n" as string]: a.paths.length }}>
        {a.paths.map((p) => (
          <div key={p.id} className="ce-branch">
            <PathCard p={p} best={a.verdict.path === p.id} warnings={similarFailed(p.action, moves)} onLock={(o) => onLock(p, o)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function OutcomeCard({ m, store, title, choice }: { m: MoveRec; store: JournalStore; title: string; choice: DeepChoice }) {
  const [text, setText] = useDraft(`outcome.${m.id}`);
  const [felt, setFelt] = useState<Felt | null>(null);
  const [saving, setSaving] = useState(false);
  const [sure, setSure] = useState(false);
  const today = dayKey(new Date());
  const due = m.checkDay <= today;
  return (
    <div className={`ce-outcome${due ? " due" : ""}`}>
      <p className="ce-outcome-head">
        {due ? "⏳ How did it go?" : `⏳ Look back on ${short(m.checkDay)}`} <span className="ce-muted">· locked in {short(m.day)}</span>
      </p>
      <p className="ce-outcome-move">{m.action}</p>
      {(m.predicted.immediate || m.predicted.months) && (
        <p className="ce-muted">
          Predicted: {m.predicted.immediate}
          {m.predicted.months ? ` → ${m.predicted.months}` : ""}
        </p>
      )}
      <textarea rows={2} value={text} placeholder="What actually happened? (saved in today's note)" onChange={(e) => setText(e.target.value)} aria-label="What happened" />
      <div className="ce-lock-row">
        {FELT.map((f) => (
          <button key={f.id} type="button" className={felt === f.id ? "on" : ""} onClick={() => setFelt(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="ce-lock-row">
        <button
          type="button"
          className="ce-primary"
          disabled={saving || !text.trim() || !felt}
          onClick={async () => {
            setSaving(true);
            try {
              await logOutcome(store, title, m.id, { text, felt: felt!, choice });
              setText("");
              showToast("🎲 Logged. The engine learns from it.");
            } catch (e) {
              showError("Couldn't save it", e);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "📝 Log what happened"}
        </button>
        <button
          type="button"
          className="ce-quiet"
          onClick={async () => {
            // Two taps: the first asks.
            if (!sure) return setSure(true);
            await removeMove(store, title, m.id).catch((e) => showError("Couldn't remove it", e));
          }}
          onBlur={() => setSure(false)}
        >
          {sure ? "Tap again to remove (notes stay)" : "Remove"}
        </button>
      </div>
    </div>
  );
}

function Questions({ qs, onDone }: { qs: string[]; onDone: (answers: string[] | null) => void }) {
  const [answers, setAnswers] = useState<string[]>(() => qs.map((_, i) => readDraft(`q.${i}.${qs[i]}`)));
  return (
    <div className="ce-ask">
      <p className="ce-ask-head">🔎 Before judging: a couple of facts</p>
      <p className="ce-muted">Journals leave things out. Your answers make the reading sharper, and they're kept for next time.</p>
      {qs.map((q, i) => (
        <label key={q} className="ce-q">
          <span>{q}</span>
          <textarea
            rows={2}
            value={answers[i] ?? ""}
            onChange={(e) => {
              const next = [...answers];
              next[i] = e.target.value;
              setAnswers(next);
              writeDraft(`q.${i}.${q}`, e.target.value);
            }}
          />
        </label>
      ))}
      <div className="ce-lock-row">
        <button type="button" className="ce-primary" disabled={!answers.some((a) => a?.trim())} onClick={() => (qs.forEach((q, i) => writeDraft(`q.${i}.${q}`, "")), onDone(answers))}>
          Answer and read
        </button>
        <button type="button" className="ce-quiet" onClick={() => onDone(null)}>
          Skip, read anyway
        </button>
      </div>
    </div>
  );
}

function Entries({ entries, clean, raw, setRaw, onOpenDay, onCleanAll, working }: { entries: Entry[]; clean: Map<string, CleanRec>; raw: boolean; setRaw: (v: boolean) => void; onOpenDay: (d: string) => void; onCleanAll: () => void; working: boolean }) {
  const [all, setAll] = useState(false);
  const newest = [...entries].reverse();
  const shown = all ? newest : newest.slice(0, 12);
  const missing = entries.filter((e) => !clean.has(e.key)).length;
  return (
    <details className="ce-entries">
      <summary>
        📜 Entries · {entries.length}
        {missing > 0 && <span className="ce-muted"> · {missing} not cleaned yet</span>}
      </summary>
      <div className="ce-lock-row">
        <button type="button" className={!raw ? "on" : ""} onClick={() => setRaw(false)}>
          ✨ Clean
        </button>
        <button type="button" className={raw ? "on" : ""} onClick={() => setRaw(true)}>
          ✍️ As written
        </button>
        {missing > 0 && (
          <button type="button" disabled={working} onClick={onCleanAll}>
            ✨ Clean up {missing} more
          </button>
        )}
      </div>
      <p className="ce-muted">The clean copy is for reading; your notes stay exactly as you wrote them. The dot is how stressed the writing looks.</p>
      <ul>
        {shown.map((e) => {
          const c = clean.get(e.key);
          const s = c?.stress ?? rawSignals(e.raw, e.hour).score;
          return (
            <li key={e.key}>
              <button type="button" className="ce-day" onClick={() => onOpenDay(e.day)}>
                {short(e.day)}
              </button>
              <span className={`ce-dot ce-${tone(s)}`} title={`Stress ${s}${c?.tone ? ` · ${c.tone}` : ""}`} />
              <p>{raw || !c ? e.raw : c.clean}</p>
            </li>
          );
        })}
      </ul>
      {!all && newest.length > shown.length && (
        <button type="button" className="ce-quiet" onClick={() => setAll(true)}>
          Show all {newest.length}
        </button>
      )}
    </details>
  );
}

function Reading({ run, data, store, title, onLocked }: { run: RunRec; data: EngineData; store: JournalStore; title: string; onLocked: () => void }) {
  const a = run.analysis;
  const [custom, setCustom] = useDraft(`custom.${title}`);
  const [ownMove, setOwnMove] = useState(false);
  const lock = async (p: Path | undefined, o: { action?: string; days: number; remind: boolean }) => {
    try {
      const checkDay = addDays(dayKey(new Date()), o.days);
      await lockIn(store, title, { run, path: p, action: p ? p.action : (o.action ?? ""), checkDay, remind: o.remind });
      showToast(`🔒 Locked in. I'll ask how it went on ${short(checkDay)}.`);
      if (!p) setCustom("");
      setOwnMove(false);
      onLocked();
    } catch (e) {
      showError("Couldn't lock it in", e);
    }
  };
  return (
    <section className="ce-reading">
      <p className="ce-summary">{a.summary}</p>
      <div className="ce-meters">
        <Meter label="😮‍💨 Stress you're writing from" value={a.stress.level} note={a.stress.reading} />
        <Meter label={`⚖️ Sunk cost · ${a.sunkCost.call}`} value={a.sunkCost.meter} note={a.sunkCost.why} />
      </div>
      {a.loops.map((l, i) => (
        <div key={i} className="ce-loop">
          <b>🔁 Loop: {l.pattern}</b>
          {l.when && <span className="ce-muted"> · {l.when}</span>}
          <p>{l.warning}</p>
        </div>
      ))}
      <div className="ce-lenses">
        <div>
          <h4>🙋 Your view</h4>
          <p>{a.lenses.mine}</p>
        </div>
        <div>
          <h4>👥 Their view</h4>
          <p>{a.lenses.theirs}</p>
        </div>
        <div>
          <h4>🧊 Cold observer</h4>
          <p>{a.lenses.observer}</p>
        </div>
      </div>
      {a.lenses.blindSpot && (
        <p className="ce-blind">
          <b>🕳️ Blind spot:</b> {a.lenses.blindSpot}
        </p>
      )}
      <ChoiceTree a={a} moves={data.moves} onLock={(p, o) => lock(p, o)} />
      <div className="ce-verdict">
        <b>★ Verdict: path {a.verdict.path}</b>
        <p>{a.verdict.text}</p>
      </div>
      {ownMove ? (
        <LockForm custom={{ draft: custom, setDraft: setCustom }} onLock={(o) => lock(undefined, o)} />
      ) : (
        <button type="button" className="ce-quiet" onClick={() => setOwnMove(true)}>
          ✍️ I'm doing something else: lock in my own move
        </button>
      )}
      <p className="ce-muted ce-by">
        Read {short(run.at)} by {run.by} ({run.model}) from {run.entries} entries.
      </p>
    </section>
  );
}

export function ConsequencePanel({ store, page, refreshKey, onOpenDay }: { store: JournalStore; page: NamedPage; refreshKey: unknown; onOpenDay: (day: string) => void }) {
  const title = page.title;
  const openKey = `journal.ce-open.${title}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(openKey) === "1";
    } catch {
      return false;
    }
  });
  const [data, setData] = useState<EngineData | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [clean, setClean] = useState<Map<string, CleanRec>>(new Map());
  const [tick, setTick] = useState(0);
  const [choice, setChoiceState] = useState<DeepChoice>(loadChoice);
  const [now, setNow] = useDraft(`now.${title}`);
  const [runId, setRunId] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const job = useJob(title);

  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent).detail?.title === title && setTick((n) => n + 1);
    window.addEventListener(ENGINE_EVENT, on);
    return () => window.removeEventListener(ENGINE_EVENT, on);
  }, [title]);

  // Closed: only the engine's own records (one page read). Open: the entries too.
  useEffect(() => {
    let live = true;
    void loadEngine(store, title).then((d) => live && setData(d), () => live && setData(null));
    if (open) {
      void loadEntries(store, title).then((e) => live && setEntries(e), () => live && setEntries([]));
      void loadClean(store, title).then((c) => live && setClean(c), () => {});
    }
    return () => {
      live = false;
    };
  }, [store, title, open, refreshKey, tick, job?.phase]);

  const today = dayKey(new Date());
  const pending = (data?.moves ?? []).filter((m) => !m.outcome).sort((a, b) => a.checkDay.localeCompare(b.checkDay));
  const due = pending.filter((m) => m.checkDay <= today).length;
  const latest = data?.runs[data.runs.length - 1];
  const run = (runId && data?.runs.find((r) => r.id === runId)) || latest;
  const stats = useMemo(() => situationStats(entries ?? [], data?.moves ?? [], today), [entries, data, today]);
  const working = busy(title);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(openKey, next ? "1" : "0");
    } catch {
      // Not remembered.
    }
  };
  const read = () => {
    const typed = now;
    void startReading(store, title, { pageText: pageTextOf(page.content), now: typed, choice }).then((saved) => {
      // The words are in today's note now; if saving them failed they stay in the box.
      if (saved) setNow("");
    });
  };

  return (
    <section className={`ce${open ? " open" : ""}`}>
      <button type="button" className="ce-head" onClick={toggle} aria-expanded={open}>
        <span className="ce-title">🎲 Consequence engine</span>
        <span className="ce-chips">
          {working && <span className="ce-chip live">● reading</span>}
          {job?.phase === "asking" && <span className="ce-chip due">🔎 questions</span>}
          {due > 0 && <span className="ce-chip due">⏳ {due} to log</span>}
          {latest && <span className="ce-chip">read {short(latest.at)}</span>}
          {data && data.moves.some((m) => typeof m.outcome?.match === "number") && <span className="ce-chip">🎯 {situationStats([], data.moves, today).accuracy}% right</span>}
        </span>
        <span className="ce-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="ce-body">
          {!latest && !working && (
            <p className="ce-muted">
              An honest strategist for this {page.props.project ? "project" : "situation"}: it reads every note linking [[{title}]], looks from your side, their side and a cold observer's, warns when you're repeating a move that failed or when walking away is smarter, and maps your next moves with what they lead to. Lock one in, log what really happened, and it learns how things actually go.
            </p>
          )}
          <div className="ce-askbox">
            <textarea rows={2} value={now} placeholder="What's happening right now, or what are you thinking of doing? (optional, saved in today's note)" onChange={(e) => setNow(e.target.value)} aria-label="What's happening now" />
            <div className="ce-lock-row">
              <select
                value={choice}
                onChange={(e) => {
                  const c = e.target.value as DeepChoice;
                  setChoiceState(c);
                  saveChoice(c);
                }}
                aria-label="Model"
              >
                {CHOICES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button type="button" className="ce-primary" disabled={working || job?.phase === "asking"} onClick={read}>
                {latest ? "🎲 Read it again" : "🎲 Read the situation"}
              </button>
            </div>
            {entries && (
              <p className="ce-muted">
                {stats.entries ? `${stats.entries} entries over ${stats.days} days (${stats.last30} this month).` : `No notes link [[${title}]] yet.`}
                {stats.logged ? ` ${stats.logged} outcome${stats.logged === 1 ? "" : "s"} logged${stats.accuracy !== null ? `, predictions ${stats.accuracy}% right` : ""}.` : ""}
              </p>
            )}
          </div>

          {job && job.phase !== "done" && job.phase !== "asking" && (
            <div className={`ce-status${job.phase === "error" ? " error" : ""}`}>
              {job.phase === "error" ? <span>⚠ {job.error}</span> : <span className="ce-spin">{job.step}</span>}
              <button type="button" className="ce-quiet" onClick={() => (job.phase === "error" ? clearJob(title) : stopReading(title))}>
                {job.phase === "error" ? "✕" : "Stop"}
              </button>
            </div>
          )}
          {job?.phase === "asking" && job.questions && <Questions qs={job.questions} onDone={(answers) => void answerQuestions(store, title, answers)} />}

          {pending.map((m) => (
            <OutcomeCard key={m.id} m={m} store={store} title={title} choice={choice} />
          ))}

          {run && data && (
            <>
              {data.runs.length > 1 && (
                <div className="ce-lock-row">
                  <select value={run.id} onChange={(e) => setRunId(e.target.value)} aria-label="Which reading">
                    {[...data.runs].reverse().map((r, i) => (
                      <option key={r.id} value={r.id}>
                        {i === 0 ? "Latest: " : ""}reading of {short(r.at)} · verdict {r.analysis.verdict.path}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <Reading run={run} data={data} store={store} title={title} onLocked={() => setTick((n) => n + 1)} />
              <div className="ce-lock-row">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const name = await saveChoiceGraph(store, title, run);
                      showToast(`🧩 Saved "${name}": open Canvas or the mind map and pick it from the graphs.`);
                    } catch (e) {
                      showError("Couldn't save the graph", e);
                    }
                  }}
                >
                  🧩 Choice tree as a graph
                </button>
                <button
                  type="button"
                  onClick={() => void copyText(situationMarkdown(title, { ...data, runs: [run] })).then(() => showToast("Copied"), (e) => showError("Couldn't copy", e))}
                >
                  ⧉ Copy
                </button>
              </div>
            </>
          )}

          {data && data.moves.some((m) => m.outcome) && (
            <details className="ce-history">
              <summary>🎯 Reality log · {data.moves.filter((m) => m.outcome).length}</summary>
              <ul>
                {[...data.moves]
                  .filter((m) => m.outcome)
                  .reverse()
                  .map((m) => (
                    <li key={m.id}>
                      <p>
                        <b>{short(m.day)}</b> {m.action}
                      </p>
                      {m.predicted.immediate && <p className="ce-muted">Predicted: {m.predicted.immediate}</p>}
                      <p>
                        Really: {m.outcome!.text}{" "}
                        {typeof m.outcome!.match === "number" && <span className={`ce-chip ce-${tone(100 - m.outcome!.match)}`}>{m.outcome!.match}% as predicted</span>}
                      </p>
                      {m.outcome!.lesson && <p className="ce-muted">Lesson: {m.outcome!.lesson}</p>}
                    </li>
                  ))}
              </ul>
            </details>
          )}

          {data?.state && (data.state.people.length > 0 || data.state.lessons.length > 0 || data.state.blindSpots.length > 0) && (
            <details className="ce-history">
              <summary>🧠 What it has learned</summary>
              {data.state.goal && <p>Goal: {data.state.goal}</p>}
              {data.state.people.map((p) => (
                <p key={p.name}>
                  <b>{p.name}:</b> {p.patterns.join(" · ")}
                </p>
              ))}
              {data.state.blindSpots.length > 0 && <p>Blind spots: {data.state.blindSpots.join(" · ")}</p>}
              {data.state.lessons.length > 0 && (
                <ul>
                  {data.state.lessons.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </details>
          )}

          {entries && entries.length > 0 && (
            <Entries entries={entries} clean={clean} raw={raw} setRaw={setRaw} onOpenDay={onOpenDay} working={working} onCleanAll={() => void cleanAll(store, title, choice)} />
          )}
        </div>
      )}
    </section>
  );
}

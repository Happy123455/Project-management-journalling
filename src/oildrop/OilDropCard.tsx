// 🛢️ The oil-drop check under a day's note: nothing on most days ("all clear" is one quiet line),
// a card when a repeating crack was found, with the "Why?" ladder going down to the root cause.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { JournalStore } from "../store";
import { MAX_WHYS, MIN_CHARS, prevDay, similarDrops, type DropRec } from "../lib/oilDrop";
import { showError, showToast } from "../lib/toast";
import { answerWhy, clearDropError, dismissDrop, dropJob, DROPS_EVENT, eveningHour, eveningOn, forgetDrops, loadDrops, openQuestion, remindFix, runCheck, subscribeDropJobs } from "./oilDrop";
import "./oilDrop.css";

const short = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const FIX_WORD = { kept: "✓ last fix kept", slipped: "↺ last fix slipped", unclear: "", none: "" } as const;

export function OilDropCard({ store, day, today, chars, refreshKey }: { store: JournalStore; day: string; today: string; chars: number; refreshKey: unknown }) {
  const [records, setRecords] = useState<DropRec[] | null>(null);
  const [tick, setTick] = useState(0);
  const [answer, setAnswer] = useState("");
  const [open, setOpen] = useState(false);
  const job = useSyncExternalStore(subscribeDropJobs, () => dropJob(day));

  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener(DROPS_EVENT, on);
    return () => window.removeEventListener(DROPS_EVENT, on);
  }, []);
  // Sync may have brought tonight's check from the other device.
  useEffect(() => forgetDrops(), [refreshKey]);
  useEffect(() => {
    let live = true;
    void loadDrops(store).then((r) => live && setRecords(r), () => live && setRecords([]));
    return () => {
      live = false;
    };
  }, [store, day, refreshKey, tick]);
  useEffect(() => setAnswer(""), [day]);

  const rec = records?.find((r) => r.id === day);
  const similar = useMemo(() => (rec && records ? similarDrops(records, rec) : []), [rec, records]);
  if (!records || !eveningOn()) return null;

  const check = () => {
    clearDropError(day);
    void runCheck(store, day);
  };
  const recent = day === today || day === prevDay(today);
  const evening = day !== today || new Date().getHours() >= Math.min(18, eveningHour());

  // Nothing yet: a quiet offer in the evening (or for yesterday), nothing on other days.
  if (!rec) {
    if (job?.error)
      return (
        <div className="od-pill od-error" role="status">
          🛢️ {job.error}
          <button type="button" onClick={check}>Try again</button>
        </div>
      );
    if (job) return <div className="od-pill" role="status"><span className="od-spin" />🛢️ {job.step}</div>;
    if (!recent || !evening || chars < MIN_CHARS) return null;
    return (
      <div className="od-pill od-offer">
        🛢️ Oil-drop check {day === today ? `runs at ${eveningHour()}:00` : "didn't run"}
        <button type="button" onClick={check}>Check now</button>
      </div>
    );
  }

  const status = job ? (job.error ? <p className="od-error-line">{job.error}</p> : <p className="od-working"><span className="od-spin" />{job.step}</p>) : null;
  const grew = chars - rec.read > 300;

  if (!rec.drop.found) {
    return (
      <div className="od-pill od-clear">
        <button type="button" className="od-clear-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          🛢️ All clear{FIX_WORD[rec.drop.lastFix] ? ` · ${FIX_WORD[rec.drop.lastFix]}` : ""}
        </button>
        {(open || grew) && <span className="od-note">{rec.drop.note}</span>}
        {(open || grew) && !job && <button type="button" onClick={check}>{grew ? "Check again (you wrote more)" : "Check again"}</button>}
        {status}
      </div>
    );
  }

  const d = rec.drop;
  const q = openQuestion(rec);
  const send = async (stop = false) => {
    const a = answer.trim();
    if (!a && !stop) return;
    setAnswer("");
    try {
      await answerWhy(store, day, a, { stop });
    } catch (e) {
      setAnswer(a);
      showError("Couldn't save the answer", e);
    }
  };
  const remind = async () => {
    try {
      const on = await remindFix(store, day);
      if (on) showToast(on === today ? "Added to today's note" : `Reminder on ${short(on)}`);
    } catch (e) {
      showError("Couldn't add the reminder", e);
    }
  };

  return (
    <section className={`od-card od-${d.level}${rec.dismissed ? " od-dismissed" : ""}`} aria-label="Oil-drop check">
      <header className="od-head">
        <span className="od-drop" aria-hidden="true" />
        <div className="od-head-text">
          <span className="od-kicker">
            {d.level === "warning" ? "Oil drop · warning" : "Oil drop · worth watching"}
            {FIX_WORD[d.lastFix] && <span className="od-chip">{FIX_WORD[d.lastFix]}</span>}
            {similar.length > 0 && <span className="od-chip od-repeat" title={similar.map((s) => `${s.day}: ${s.drop.symptom}`).join("\n")}>🔁 seen {similar.length + 1}× (last {short(similar[0].day)})</span>}
          </span>
          <b className="od-symptom">{d.symptom}</b>
        </div>
      </header>
      {rec.dismissed ? (
        <p className="od-muted">
          You marked this as not a real problem; later checks won't raise it unless it gets worse.{" "}
          <button type="button" className="od-quiet" onClick={() => void dismissDrop(store, day, false)}>Undo</button>
        </p>
      ) : (
        <>
          {d.evidence.length > 0 && (
            <ul className="od-evidence">
              {d.evidence.map((e, i) => (
                <li key={i}>
                  <span className="od-day">{short(e.day)}</span>“{e.quote}”
                </li>
              ))}
            </ul>
          )}
          <div className="od-pair">
            {d.trap && (
              <div>
                <h4>🔩 Tempting surface fix</h4>
                <p>{d.trap}</p>
              </div>
            )}
            <div>
              <h4>⚠️ If the cause is left (2–4 weeks)</h4>
              <p>{rec.final?.risk || d.risk}</p>
            </div>
          </div>

          {/* The ladder: each why goes one layer deeper, down to the root. */}
          <ol className="od-ladder" style={{ ["--n" as string]: MAX_WHYS }}>
            {rec.whys.map((w, i) => (
              <li key={i} style={{ ["--i" as string]: i }}>
                <span className="od-q">{w.q}</span>
                <span className="od-a">{w.a}</span>
              </li>
            ))}
            {q && (
              <li className="od-open" style={{ ["--i" as string]: rec.whys.length }}>
                <span className="od-q">{q}</span>
                <form
                  className="od-answer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="One sentence, honestly" disabled={!!job && !job.error} enterKeyHint="send" />
                  <button type="submit" className="od-primary" disabled={!answer.trim() || (!!job && !job.error)}>Why ↓</button>
                </form>
                {rec.whys.length > 0 && !job && (
                  <button type="button" className="od-quiet" onClick={() => void send(true)}>That's the bottom: sum it up</button>
                )}
              </li>
            )}
            {rec.final && (
              <li className="od-root" style={{ ["--i" as string]: rec.whys.length }}>
                <span className="od-q">Root cause</span>
                <span className="od-a">{rec.final.root}</span>
              </li>
            )}
          </ol>
          {!q && !rec.final && rec.whys.length > 0 && (!job || job.error) && (
            <button type="button" className="od-quiet" onClick={() => (clearDropError(day), void answerWhy(store, day, ""))}>{job?.error ? "Try again" : "Continue the drill"}</button>
          )}
          {status}

          <div className="od-fix">
            <div>
              <h4>🔧 {rec.final ? "Fix for the root" : "Small fix for tomorrow"}</h4>
              <p>{rec.final?.fix || d.fix}</p>
            </div>
            {rec.fixDay ? <span className="od-chip">⏰ {rec.fixDay === today ? "in today's note" : short(rec.fixDay)}</span> : <button type="button" onClick={() => void remind()}>⏰ Remind me</button>}
          </div>
          {rec.final && <p className="od-muted">The whys and the root cause are in this day's note.</p>}
          <footer className="od-foot">
            <span className="od-muted">{rec.auto ? "Evening check" : "Checked"} · {rec.by} · {d.confidence}% sure</span>
            {!job && !rec.whys.length && <button type="button" className="od-quiet" onClick={check}>Check again</button>}
            <button type="button" className="od-quiet" onClick={() => void dismissDrop(store, day)}>Not a real problem</button>
          </footer>
        </>
      )}
    </section>
  );
}

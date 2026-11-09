import { useState } from "react";
import { createPortal } from "react-dom";
import { clock, dayLabel, hm, midnight, overlaps, parseDuration, PLAN_KINDS, pushLater, splitPlan, type Plan, type Step } from "../lib/deadline";
import { dayKey } from "../lib/timestamp";
import { fx } from "../lib/fx";
import { randomLid } from "../sync/lineIds";
import { useEscapeToClose } from "../ui/useEscapeToClose";

const MIN = 60_000;
const DAY = 86_400_000;

/** "14:30" on a day → ms. */
function at(day: string, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  return m ? midnight(day) + (Number(m[1]) * 60 + Number(m[2])) * MIN : null;
}

/**
 * One plan opened big: every detail editable by exact numbers (day, start, end, length, ±5/±15
 * nudges), its kind, the step it works on, a note, done; and Duplicate, Split, Repeat, Move to the
 * next free time, Focus. Edits stay in a draft until Save, and Save can be undone from the toast.
 */
export function PlanSheet({ plan, plans, days, steps, endAt, nextFree, onSave, onFocus, onClose }: {
  plan: Plan;
  plans: Plan[];
  days: string[];
  steps: Step[];
  endAt: number;
  /** The next free start for `len` from `after` (routine, other plans and other deadlines counted). */
  nextFree: (len: number, after: number, ignore: string) => number | null;
  onSave: (plans: Plan[], message: string) => void;
  onFocus: (p: Plan) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<Plan>(plan);
  const [lenText, setLenText] = useState(hm(plan.end - plan.start));
  const [splitAt, setSplitAt] = useState(clock(plan.start + Math.round((plan.end - plan.start) / 2 / (5 * MIN)) * 5 * MIN));
  const [repeatN, setRepeatN] = useState(3);
  const close = () => (fx("close"), onClose());
  useEscapeToClose(close);
  const day = dayKey(new Date(d.start));
  const len = d.end - d.start;
  const others = plans.filter((p) => p.id !== plan.id);
  const withDraft = [...others, d];
  const clash = overlaps(withDraft, new Set([d.id]));
  const set = (patch: Partial<Plan>, sound: "nudge" | "tick" | null = "tick") => {
    const next = { ...d, ...patch };
    if (next.end - next.start < 5 * MIN) next.end = next.start + 5 * MIN;
    setD(next);
    setLenText(hm(next.end - next.start));
    if (sound) fx(sound);
  };
  const nudgeStart = (m: number) => set({ start: d.start + m * MIN, end: d.end + m * MIN }, "nudge");
  const nudgeLen = (m: number) => set({ end: Math.max(d.start + 5 * MIN, d.end + m * MIN) }, "nudge");
  const save = (list: Plan[], message: string, sound: "drop" | "done" = "drop") => {
    fx(sound);
    onSave(list, message);
    onClose();
  };
  const commit = () => save(withDraft, `Saved ${d.text || "plan"} · ${clock(d.start)}–${clock(d.end)}`);
  const moveDay = (k: string) => {
    const shift = midnight(k) - midnight(day);
    set({ start: d.start + shift, end: d.end + shift });
  };

  return createPortal(
    <div className="dls-back" onClick={close}>
      <div className="dls" role="dialog" aria-label="Plan" onClick={(e) => e.stopPropagation()} style={{ ["--kind" as string]: PLAN_KINDS.find((k) => k.id === (d.kind ?? "focus"))?.color }}>
        <div className="dls-grip" />
        <header className="dls-head">
          <button type="button" className={`dls-check${d.done ? " on" : ""}`} onClick={() => {
            fx(d.done ? "undone" : "done");
            set({ done: !d.done }, null);
          }} aria-label={d.done ? "Not done" : "Done"}>{d.done ? "✓" : ""}</button>
          <input className="dls-title" value={d.text} placeholder="What's this time for?" onChange={(e) => setD({ ...d, text: e.target.value })} />
          <button type="button" className="dls-x" onClick={close} aria-label="Close">✕</button>
        </header>

        <section className="dls-time">
          <label>
            <span>Day</span>
            <select value={day} onChange={(e) => moveDay(e.target.value)}>
              {[...new Set([...days, day])].sort().map((k) => <option key={k} value={k}>{dayLabel(k).text}</option>)}
            </select>
          </label>
          <label>
            <span>Start</span>
            <input type="time" value={clock(d.start)} onChange={(e) => {
              const s = at(day, e.target.value);
              if (s !== null) set({ start: s, end: s + len });
            }} />
          </label>
          <label>
            <span>End</span>
            <input type="time" value={clock(d.end)} onChange={(e) => {
              let t = at(day, e.target.value);
              if (t === null) return;
              if (t <= d.start) t += DAY;
              set({ end: t });
            }} />
          </label>
          <label>
            <span>Length</span>
            <input value={lenText} inputMode="text" onChange={(e) => setLenText(e.target.value)} onBlur={() => {
              const m = parseDuration(lenText);
              if (m && m >= 5) set({ end: d.start + m * MIN });
              else setLenText(hm(len));
            }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          </label>
        </section>

        <div className="dls-nudge">
          <span>Move</span>
          {[-15, -5, 5, 15].map((m) => <button key={m} type="button" onClick={() => nudgeStart(m)}>{m > 0 ? `+${m}` : m}</button>)}
          <span>Length</span>
          {[-15, -5, 5, 15].map((m) => <button key={m} type="button" onClick={() => nudgeLen(m)}>{m > 0 ? `+${m}` : m}</button>)}
        </div>

        {(clash || d.end > endAt) && (
          <div className="dls-warn">
            {clash && <span>⚠️ Overlaps another plan</span>}
            {clash && <button type="button" onClick={() => save(pushLater(withDraft, d.id), "Pushed the plans after it later")}>Push the rest later</button>}
            {d.end > endAt && <span>⚠️ Ends after the deadline ({clock(endAt)})</span>}
          </div>
        )}

        <div className="dls-kinds" role="radiogroup" aria-label="Kind">
          {PLAN_KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={(d.kind ?? "focus") === k.id} className={(d.kind ?? "focus") === k.id ? "on" : ""} style={{ ["--c" as string]: k.color }} onClick={() => set({ kind: k.id })}>
              {k.icon} {k.label}
            </button>
          ))}
        </div>

        {steps.length > 0 && (
          <label className="dls-row">
            <span>Step</span>
            <select value={d.step ?? ""} onChange={(e) => set({ step: e.target.value || undefined })}>
              <option value="">None</option>
              {steps.map((s) => <option key={s.id} value={s.id}>{s.done ? "✓ " : ""}{s.text}</option>)}
            </select>
          </label>
        )}

        <textarea className="dls-note" placeholder="Note…" value={d.note ?? ""} onChange={(e) => setD({ ...d, note: e.target.value })} />

        {d.actual?.length ? <p className="hint">Focused {hm(d.actual.reduce((s, a) => s + a.end - a.start, 0))} in {d.actual.length} session{d.actual.length === 1 ? "" : "s"}</p> : null}

        <div className="dls-actions">
          <button type="button" onClick={() => (onFocus(d), onClose())}>▶ Focus</button>
          <button type="button" onClick={() => {
            const at = nextFree(len, Math.max(Date.now(), d.end), d.id);
            if (at === null) return fx("warn");
            save([...others, { ...d, start: at, end: at + len }], `Moved to ${dayLabel(dayKey(new Date(at))).text} ${clock(at)}`);
          }}>⇥ Next free time</button>
          <button type="button" onClick={() => {
            const copy = { ...d, id: randomLid(), done: false, actual: undefined };
            const at = nextFree(len, d.end, "") ?? d.end;
            save([...withDraft, { ...copy, start: at, end: at + len }], `Duplicated at ${clock(at)}`);
          }}>⧉ Duplicate</button>
          <span className="dls-inline">
            <button type="button" onClick={() => {
              const t = at(day, splitAt);
              const halves = t === null ? null : splitPlan(d, t, randomLid());
              if (!halves) return fx("warn");
              save([...others, ...halves], `Split at ${splitAt}`);
            }}>✂ Split at</button>
            <input type="time" value={splitAt} onChange={(e) => setSplitAt(e.target.value)} />
          </span>
          <span className="dls-inline">
            <button type="button" onClick={() => {
              const copies: Plan[] = [];
              let s = d.start;
              for (let i = 0; i < repeatN; i++) {
                s = nextRepeatDay(s);
                copies.push({ ...d, id: randomLid(), start: s, end: s + len, done: false, actual: undefined });
              }
              save([...withDraft, ...copies], `Repeated on the next ${repeatN} days`);
            }}>↻ Repeat on next</button>
            <input type="number" min={1} max={30} value={repeatN} onChange={(e) => setRepeatN(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
            <small>days</small>
          </span>
          <button type="button" className="danger" onClick={() => (fx("delete"), onSave(others, `Deleted ${d.text || "plan"}`), onClose())}>🗑 Delete</button>
        </div>

        <footer className="dls-foot">
          <button type="button" onClick={close}>Cancel</button>
          <button type="button" className="primary" onClick={commit}>Save</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const nextRepeatDay = (t: number) => {
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

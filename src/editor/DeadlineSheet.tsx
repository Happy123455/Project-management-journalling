import { useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { askAi, AiUnavailableError } from "../ai/client";
import { clock, dayLabel, DEADLINE_COLORS, hm, midnight, needMins, nextRepeat, parseDuration, reviewOf, type DeadlineInfo, type DeadlineTemplate, type Free, type Plan, type Step } from "../lib/deadline";
import { dayKey } from "../lib/timestamp";
import { fx, fxOn, setFxOn } from "../lib/fx";
import { showError, showToast } from "../lib/toast";
import { randomLid } from "../sync/lineIds";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { deadlineRows, deleteDeadline, retime, savePlans, setAll } from "./deadlineStore";

const MIN = 60_000;

const TEMPLATES_KEY = "journal.deadlineTemplates";
export function savedTemplates(): DeadlineTemplate[] {
  try {
    return JSON.parse(localStorage.getItem(TEMPLATES_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveTemplate(t: DeadlineTemplate) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify([...savedTemplates().filter((x) => x.name !== t.name), t]));
  } catch {
    // Private mode.
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localDT = (t: number) => `${dateOf(t)}T${clock(t)}`;

const SYSTEM =
  "You re-plan the rest of a person's deadline. You get the work still to do (steps with minutes left), plans they missed, " +
  "the free stretches left before the deadline (day, start, end, 24h clock), what's already planned, and their preferences. " +
  "Place the work inside the free stretches only, never overlapping each other or existing plans, in sensible blocks (25 to 120 minutes, " +
  "hard focus work when fresh, short breaks between long blocks). Split big steps over several days. Use the step id when a plan works on a step. " +
  "Leave out what can't fit and say so in the note. Answer with JSON only.";
const SCHEMA = {
  type: "object",
  properties: {
    plan: { type: "array", items: { type: "object", properties: { text: { type: "string" }, day: { type: "string", description: "YYYY-MM-DD" }, start: { type: "string", description: "HH:MM" }, end: { type: "string", description: "HH:MM" }, step: { type: "string" } }, required: ["text", "day", "start", "end"] } },
    note: { type: "string", description: "One short sentence: how it fits, or what didn't fit." },
  },
  required: ["plan"],
};

/**
 * ⏳ A deadline's settings, opened by tapping its name: rename, move the due time, colour and emoji,
 * notes, the work it needs, steps (with estimates and milestone times), reminders, snap and sounds,
 * repeat and templates, AI re-plan, the review after it's due, done/archive/delete.
 */
export function DeadlineSheet({ editor, info, prefs, plans, gaps, now, onClose }: {
  editor: Editor;
  info: DeadlineInfo;
  prefs: string;
  plans: Plan[];
  /** Free stretches left before the deadline (routine, plans and other deadlines counted). */
  gaps: Free[];
  now: number;
  onClose: () => void;
}) {
  const close = () => (fx("close"), onClose());
  useEscapeToClose(close);
  const tid = info.tid;
  const set = (attrs: Partial<DeadlineInfo> | Record<string, unknown>) => setAll(editor, tid, attrs);
  const [title, setTitle] = useState(info.title);
  const [due, setDue] = useState(localDT(info.endAt));
  const [notes, setNotes] = useState(info.notes);
  const [needText, setNeedText] = useState(info.need ? hm(info.need * MIN) : "");
  const [newStep, setNewStep] = useState("");
  const [newMins, setNewMins] = useState("1h");
  const [fxState, setFxState] = useState(fxOn());
  const [tname, setTname] = useState(info.title);
  const [thinking, setThinking] = useState(false);
  const [proposal, setProposal] = useState<{ plans: Plan[]; note: string; replace: Set<string> } | null>(null);
  const steps = info.steps;
  const need = needMins(info);
  const past = info.endAt <= now;

  const setSteps = (list: Step[], sound: "tick" | "done" | "undone" | "delete" = "tick") => {
    fx(sound);
    set({ steps: list });
  };
  const planStep = (s: Step) => {
    const spent = plans.filter((p) => p.step === s.id).reduce((t, p) => t + p.end - p.start, 0);
    const left = Math.max(15 * MIN, s.mins * MIN - spent);
    const len = Math.min(left, 2 * 60 * MIN);
    const g = gaps.find((x) => x.end - Math.max(x.start, now) >= Math.min(len, 25 * MIN));
    if (!g) return fx("warn"), showToast("No free time left before the deadline");
    const start = Math.max(g.start, now);
    const end = Math.min(g.end, start + len);
    fx("drop");
    savePlans(editor, tid, [...plans, { id: randomLid(), start, end, text: s.text, step: s.id, kind: "focus" }], `Planned ${s.text} · ${dayLabel(dayKey(new Date(start))).text} ${clock(start)}`);
  };

  const replan = async () => {
    setThinking(true);
    try {
      const missed = plans.filter((p) => !p.done && p.end <= now && !p.actual?.length);
      const futureAi = plans.filter((p) => !p.done && p.start > now && p.ai);
      const keep = plans.filter((p) => !missed.includes(p) && !futureAi.includes(p) && p.end > now && !p.done);
      const left = steps.filter((s) => !s.done).map((s) => {
        const spent = plans.filter((p) => p.step === s.id && (p.done || p.actual?.length)).reduce((t, p) => t + (p.actual?.length ? p.actual.reduce((a, x) => a + x.end - x.start, 0) : p.end - p.start), 0);
        const planned = keep.filter((p) => p.step === s.id).reduce((t, p) => t + p.end - p.start, 0);
        return { id: s.id, text: s.text, minutesLeft: Math.max(0, Math.round((s.mins * MIN - spent - planned) / MIN)) };
      }).filter((s) => s.minutesLeft > 0);
      const ask = {
        now: `${dateOf(now)} ${clock(now)}`,
        deadline: `${dateOf(info.endAt)} ${clock(info.endAt)}`,
        work: left,
        missed: missed.map((p) => ({ text: p.text, minutes: Math.round((p.end - p.start) / MIN), step: p.step })),
        free: gaps.slice(0, 60).map((g) => ({ day: dateOf(g.start), start: clock(Math.max(g.start, now)), end: clock(g.end) })),
        alreadyPlanned: keep.map((p) => ({ text: p.text, day: dateOf(p.start), start: clock(p.start), end: clock(p.end) })),
        preferences: prefs || "none given",
      };
      if (!left.length && !missed.length) return showToast("Nothing left to plan");
      const answer = await askAi<{ plan: { text: string; day: string; start: string; end: string; step?: string }[]; note?: string }>({ task: "organise", system: SYSTEM, text: JSON.stringify(ask), schema: SCHEMA, maxTokens: 2500, cloud: true });
      const placed: Plan[] = [];
      for (const p of answer.json?.plan ?? []) {
        const m1 = /^(\d{1,2}):(\d{2})/.exec(p.start);
        const m2 = /^(\d{1,2}):(\d{2})/.exec(p.end);
        if (!m1 || !m2 || !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) continue;
        const s = midnight(p.day) + (Number(m1[1]) * 60 + Number(m1[2])) * MIN;
        let e = midnight(p.day) + (Number(m2[1]) * 60 + Number(m2[2])) * MIN;
        if (e <= s) e += 86_400_000;
        if (s < now || e > info.endAt) continue;
        placed.push({ id: randomLid(), start: s, end: e, text: p.text, ai: answer.actor, step: steps.some((x) => x.id === p.step) ? p.step : undefined, kind: "focus" });
      }
      if (!placed.length) return showToast("The AI couldn't place anything");
      fx("open");
      setProposal({ plans: placed, note: answer.json?.note || `Planned by ${answer.actor}`, replace: new Set([...missed, ...futureAi].map((p) => p.id)) });
    } catch (e) {
      if (e instanceof AiUnavailableError) showToast("Turn AI on and add a Gemini key in Settings");
      else showError("Couldn't re-plan", e);
    } finally {
      setThinking(false);
    }
  };

  const makeNext = () => {
    const end = nextRepeat(info.endAt, info.repeat);
    const rows = deadlineRows(end, info.title, {
      emoji: info.emoji, color: info.color, notes: info.notes, need: info.need, remind: info.remind, dueAlerts: info.dueAlerts, snap: info.snap, repeat: info.repeat, prefs,
      steps: steps.map((s) => ({ ...s, id: randomLid(), done: false, at: s.at ? nextRepeat(s.at, info.repeat) : undefined })),
    }, dayKey(new Date(Math.max(now, info.endAt))));
    editor.chain().insertContentAt(editor.state.doc.content.size, [{ type: "paragraph" }, ...rows]).run();
    fx("done");
    showToast(`Next ${info.title || "deadline"}: due ${dayLabel(dayKey(new Date(end))).text}`, "info", { label: "Undo", run: () => editor.commands.undo() });
  };

  const review = (past || info.status === "done") ? reviewOf(steps, plans) : [];

  return createPortal(
    <div className="dls-back" onClick={close}>
      <div className="dls dls-wide" role="dialog" aria-label="Deadline settings" onClick={(e) => e.stopPropagation()} style={{ ["--kind" as string]: info.color }}>
        <div className="dls-grip" />
        <header className="dls-head">
          <input className="dls-emoji" value={info.emoji} maxLength={4} onChange={(e) => set({ emoji: e.target.value || "⏳" })} aria-label="Emoji" />
          <input className="dls-title" value={title} placeholder="What's due?" onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== info.title && set({ title })} />
          <button type="button" className="dls-x" onClick={close} aria-label="Close">✕</button>
        </header>

        <section className="dls-sec">
          <h4>Due</h4>
          <div className="dls-line">
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            <button type="button" disabled={due === localDT(info.endAt)} onClick={() => {
              const t = new Date(due).getTime();
              if (!(t > 0)) return fx("warn");
              retime(editor, tid, t);
              fx("drop");
              showToast(`Due moved to ${dayLabel(dayKey(new Date(t))).text} ${clock(t)}`, "info", { label: "Undo", run: () => editor.commands.undo() });
            }}>Move due</button>
          </div>
          <div className="dls-swatches" role="radiogroup" aria-label="Colour">
            {DEADLINE_COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={info.color === c} className={info.color === c ? "on" : ""} style={{ background: c }} onClick={() => (fx("tick"), set({ color: c }))} aria-label={c} />)}
          </div>
          <textarea className="dls-note" placeholder="What it's about, links, the brief…" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== info.notes && set({ notes })} />
        </section>

        <section className="dls-sec">
          <h4>Work it needs</h4>
          <div className="dls-line">
            <input placeholder={steps.length ? `${hm(steps.reduce((s, x) => s + x.mins, 0) * MIN)} from steps` : "e.g. 12h"} value={needText} onChange={(e) => setNeedText(e.target.value)} onBlur={() => {
              const m = needText.trim() ? parseDuration(needText) : 0;
              if (m === null) return setNeedText(info.need ? hm(info.need * MIN) : "");
              set({ need: m });
            }} />
            <small className="hint">{need ? `${hm(need * MIN)} in total` : "Set it to see if you're on track"}</small>
          </div>
        </section>

        <section className="dls-sec">
          <h4>Steps</h4>
          <ul className="dls-steps">
            {steps.map((s, i) => (
              <li key={s.id} className={s.done ? "done" : ""}>
                <button type="button" className={`dls-check sm${s.done ? " on" : ""}`} onClick={() => setSteps(steps.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)), s.done ? "undone" : "done")} aria-label="Done">{s.done ? "✓" : ""}</button>
                <input defaultValue={s.text} onBlur={(e) => e.target.value !== s.text && set({ steps: steps.map((x) => (x.id === s.id ? { ...x, text: e.target.value } : x)) })} />
                <input className="dls-mins" defaultValue={hm(s.mins * MIN)} onBlur={(e) => {
                  const m = parseDuration(e.target.value);
                  if (m !== null) setSteps(steps.map((x) => (x.id === s.id ? { ...x, mins: m } : x)));
                }} aria-label="Estimate" />
                <input className="dls-at" type="datetime-local" value={s.at ? localDT(s.at) : ""} title="Milestone: a 🚩 on the bars" onChange={(e) => setSteps(steps.map((x) => (x.id === s.id ? { ...x, at: e.target.value ? new Date(e.target.value).getTime() : undefined } : x)))} />
                <button type="button" onClick={() => planStep(s)} title="Plan it in the next free time">⇥</button>
                <button type="button" disabled={i === 0} onClick={() => setSteps([...steps.slice(0, i - 1), s, steps[i - 1], ...steps.slice(i + 1)])} aria-label="Move up">↑</button>
                <button type="button" onClick={() => setSteps(steps.filter((x) => x.id !== s.id), "delete")} aria-label="Delete step">✕</button>
              </li>
            ))}
          </ul>
          <div className="dls-line">
            <input placeholder="Add a step…" value={newStep} onChange={(e) => setNewStep(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.nextElementSibling?.nextElementSibling as HTMLButtonElement)?.click()} />
            <input className="dls-mins" value={newMins} onChange={(e) => setNewMins(e.target.value)} aria-label="Estimate" />
            <button type="button" onClick={() => {
              if (!newStep.trim()) return;
              setSteps([...steps, { id: randomLid(), text: newStep.trim(), mins: parseDuration(newMins) ?? 60 }]);
              setNewStep("");
            }}>Add</button>
          </div>
        </section>

        <section className="dls-sec">
          <h4>Reminders &amp; feel</h4>
          <label className="dls-row">
            <span>Before each plan</span>
            <select value={info.remind} onChange={(e) => (fx("tick"), set({ remind: Number(e.target.value) }))}>
              {[0, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m ? `${m} min` : "Off"}</option>)}
            </select>
          </label>
          <label className="dls-row">
            <span>Due alerts (a day and an hour before)</span>
            <input type="checkbox" checked={info.dueAlerts} onChange={(e) => (fx("tick"), set({ dueAlerts: e.target.checked }))} />
          </label>
          <label className="dls-row">
            <span>Drag snap</span>
            <select value={info.snap} onChange={(e) => (fx("tick"), set({ snap: Number(e.target.value) }))}>
              {[1, 2, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
          <label className="dls-row">
            <span>Sounds &amp; haptics (all deadlines)</span>
            <input type="checkbox" checked={fxState} onChange={(e) => {
              setFxOn(e.target.checked);
              setFxState(e.target.checked);
              fx("tick");
            }} />
          </label>
        </section>

        <section className="dls-sec">
          <h4>Repeat &amp; templates</h4>
          <label className="dls-row">
            <span>Repeats</span>
            <select value={info.repeat} onChange={(e) => (fx("tick"), set({ repeat: e.target.value }))}>
              <option value="">Never</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </label>
          <div className="dls-line">
            {info.repeat && <button type="button" onClick={makeNext}>⟳ Make the next one ({dayLabel(dayKey(new Date(nextRepeat(info.endAt, info.repeat)))).text})</button>}
            <input className="dls-tname" placeholder="Template name" value={tname} onChange={(e) => setTname(e.target.value)} />
            <button type="button" disabled={!tname.trim()} onClick={() => {
              const name = tname.trim();
              saveTemplate({ name, emoji: info.emoji, color: info.color, steps: steps.map((s) => ({ text: s.text, mins: s.mins })), prefs });
              fx("done");
              showToast(`Saved template “${name}”`);
            }}>💾 Save as template</button>
          </div>
        </section>

        <section className="dls-sec">
          <h4>✨ Re-plan with AI</h4>
          <p className="hint">Moves missed plans and the AI's own future plans into the free time left, around what you planned by hand. You see it first.</p>
          {!proposal ? (
            <button type="button" disabled={thinking || past} onClick={() => void replan()}>{thinking ? "Planning…" : "Re-plan the rest"}</button>
          ) : (
            <div className="dls-proposal">
              <p>{proposal.note}</p>
              <ul>
                {proposal.plans.map((p) => <li key={p.id}><b>{dayLabel(dayKey(new Date(p.start))).text} {clock(p.start)}–{clock(p.end)}</b> {p.text}</li>)}
              </ul>
              <div className="dls-line">
                <button type="button" className="primary" onClick={() => {
                  fx("done");
                  savePlans(editor, tid, [...plans.filter((p) => !proposal.replace.has(p.id)), ...proposal.plans], `Re-planned ${proposal.plans.length} blocks`);
                  setProposal(null);
                }}>Use this plan</button>
                <button type="button" onClick={() => (fx("close"), setProposal(null))}>Discard</button>
              </div>
            </div>
          )}
        </section>

        {review.length > 0 && (
          <section className="dls-sec">
            <h4>Review</h4>
            <table className="dls-review">
              <thead><tr><th>Step</th><th>Guess</th><th>Planned</th><th>Spent</th></tr></thead>
              <tbody>
                {review.map((r) => (
                  <tr key={r.id || "other"} className={r.estimate && r.spent > r.estimate * 1.2 ? "over" : ""}>
                    <td>{r.done ? "✓ " : ""}{r.text}</td>
                    <td>{r.estimate ? hm(r.estimate) : "–"}</td>
                    <td>{hm(r.planned)}</td>
                    <td>{hm(r.spent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(() => {
              const over = review.filter((r) => r.estimate && r.spent > r.estimate * 1.2);
              return over.length ? <p className="hint">Took longer than you guessed: {over.map((r) => r.text).join(", ")}. Guess higher next time.</p> : <p className="hint">Your guesses held up.</p>;
            })()}
          </section>
        )}

        <footer className="dls-foot">
          {info.status === "done" ? (
            <button type="button" onClick={() => (fx("undone"), set({ status: "" }))}>Reopen</button>
          ) : (
            <button type="button" className="primary" onClick={() => (fx("done"), set({ status: "done" }), showToast(`🎉 ${info.title || "Deadline"} done`))}>✓ Mark done</button>
          )}
          <button type="button" onClick={() => (fx("tick"), set({ status: info.status === "archived" ? "" : "archived", collapsed: info.status !== "archived" }))}>{info.status === "archived" ? "Unarchive" : "Archive"}</button>
          <button type="button" className="danger" onClick={() => (fx("delete"), onClose(), deleteDeadline(editor, tid, info.title))}>🗑 Delete</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

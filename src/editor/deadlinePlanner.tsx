import { useState } from "react";
import { createPortal } from "react-dom";
import { askAi, AiUnavailableError } from "../ai/client";
import { clock, hm, type Busy, type Plan } from "../lib/deadline";
import { showError, showToast } from "../lib/toast";
import { randomLid } from "../sync/lineIds";
import { useEscapeToClose } from "../ui/useEscapeToClose";

const MIN = 60_000;
const SYSTEM =
  "You plan a person's free time. You get one free stretch of their day (start and end, 24h clock), the routine blocks around it, " +
  "the tasks they want to fit in (each with minutes, 0 = you choose), what's already placed, and their preferences. " +
  "Place the tasks inside the stretch without overlapping each other, in a sensible order (hard focus work when fresh, short breaks between long blocks, " +
  "nothing past the end). Leave tasks out only if they can't fit. Answer with JSON only.";
const SCHEMA = {
  type: "object",
  properties: {
    plan: { type: "array", items: { type: "object", properties: { text: { type: "string" }, start: { type: "string", description: "HH:MM" }, end: { type: "string", description: "HH:MM" } }, required: ["text", "start", "end"] } },
    note: { type: "string", description: "One short sentence about the plan, or what didn't fit." },
  },
  required: ["plan"],
};

/** "14:30" on the day of `ref` (next day when it's before the stretch started, for plans past midnight). */
function atClock(hhmm: string, ref: number): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const d = new Date(ref);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime() < ref - 3_600_000 ? d.getTime() + 86_400_000 : d.getTime();
}

/**
 * A free stretch of a deadline bar, opened big: plan it by hand (task + minutes, placed in the next
 * open spot, start time editable) or let the AI arrange the tasks around the routine with your
 * preferences. Plans are kept on that day's bar, and shown on it.
 */
export function Planner({ start, end, busy, plans, prefs, onPlans, onPrefs, onClose }: {
  start: number;
  end: number;
  busy: Busy[];
  plans: Plan[];
  prefs: string;
  onPlans: (p: Plan[]) => void;
  onPrefs: (p: string) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const inside = plans.filter((p) => p.end > start && p.start < end).sort((a, b) => a.start - b.start);
  const [text, setText] = useState("");
  const [mins, setMins] = useState(45);
  const [wish, setWish] = useState(prefs);
  const [todo, setTodo] = useState("");
  const [busyAi, setBusyAi] = useState(false);
  const span = end - start;

  const nextSlot = (len: number) => {
    let at = start;
    for (const p of inside) if (p.start - at >= len) break; else at = Math.max(at, p.end);
    return at + len <= end ? at : null;
  };
  const add = () => {
    const len = Math.max(5, mins) * MIN;
    const at = nextSlot(len);
    if (!text.trim()) return;
    if (at === null) return showToast("Doesn't fit in this free time");
    onPlans([...plans, { id: randomLid(), start: at, end: at + len, text: text.trim() }]);
    setText("");
  };
  const move = (id: string, hhmm: string) => {
    const p = plans.find((x) => x.id === id);
    const at = p && atClock(hhmm, start);
    if (!p || at === null || at === undefined) return;
    onPlans(plans.map((x) => (x.id === id ? { ...x, start: at, end: at + (p.end - p.start) } : x)));
  };
  const remove = (id: string) => onPlans(plans.filter((x) => x.id !== id));

  const arrange = async () => {
    const tasks = todo.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!tasks.length && !inside.length) return showToast("Write the tasks to fit in first, one per line");
    setBusyAi(true);
    if (wish !== prefs) onPrefs(wish);
    try {
      const ask = {
        free: { start: clock(start), end: clock(end) },
        routine: busy.map((b) => ({ what: b.label, start: clock(b.start), end: clock(b.end) })),
        tasks: [...inside.map((p) => ({ text: p.text, minutes: Math.round((p.end - p.start) / MIN) })), ...tasks.map((t) => {
          const m = /(\d+)\s*(m|min|h|hr|hour)s?\b/i.exec(t);
          const minutes = m ? Number(m[1]) * (m[2].toLowerCase().startsWith("h") ? 60 : 1) : 0;
          return { text: t, minutes };
        })],
        preferences: wish || "none given",
      };
      const answer = await askAi<{ plan: { text: string; start: string; end: string }[]; note?: string }>({ task: "organise", system: SYSTEM, text: JSON.stringify(ask), schema: SCHEMA, maxTokens: 1500, cloud: true });
      const placed: Plan[] = [];
      for (const p of answer.json?.plan ?? []) {
        const s = atClock(p.start, start);
        const e = atClock(p.end, start);
        if (s === null || e === null || e <= s) continue;
        placed.push({ id: randomLid(), start: Math.max(s, start), end: Math.min(e, end), text: p.text, ai: answer.actor });
      }
      if (!placed.length) return showToast("The AI couldn't place anything");
      onPlans([...plans.filter((p) => !(p.end > start && p.start < end)), ...placed]);
      setTodo("");
      showToast(answer.json?.note || `Planned by ${answer.actor}`);
    } catch (e) {
      if (e instanceof AiUnavailableError) showToast("Turn AI on and add a Gemini key in Settings");
      else showError("Couldn't plan", e);
    } finally {
      setBusyAi(false);
    }
  };

  return createPortal(
    <div className="dl-planner-back" onClick={onClose}>
      <div className="dl-planner" role="dialog" aria-label="Plan free time" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>🗓 {clock(start)}–{clock(end)}</strong>
          <span className="hint">{hm(span)} free{inside.length ? `, ${hm(span - inside.reduce((s, p) => s + p.end - p.start, 0))} left` : ""}</span>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="dl-plan-rail">
          {inside.map((p) => (
            <div key={p.id} className={`dl-plan-block${p.ai ? " ai" : ""}`} style={{ top: `${((p.start - start) / span) * 100}%`, height: `${((p.end - p.start) / span) * 100}%` }}>
              <span>{p.text}</span>
            </div>
          ))}
        </div>
        <ul className="dl-plan-list">
          {inside.map((p) => (
            <li key={p.id}>
              <input type="time" value={clock(p.start)} onChange={(e) => move(p.id, e.target.value)} />
              <span>{p.text} <small>{hm(p.end - p.start)}{p.ai ? ` · ${p.ai}` : ""}</small></span>
              <button type="button" onClick={() => remove(p.id)} aria-label="Remove">✕</button>
            </li>
          ))}
        </ul>
        <div className="dl-plan-add">
          <input placeholder="Task" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <input type="number" min={5} step={5} value={mins} onChange={(e) => setMins(Number(e.target.value))} aria-label="Minutes" />
          <span>min</span>
          <button type="button" onClick={add}>Add</button>
        </div>
        <details className="dl-plan-ai" open={!inside.length}>
          <summary>✨ Let AI arrange it</summary>
          <textarea placeholder={"Tasks, one per line (\"ESD2 sums 2h\", \"emails 20m\")"} value={todo} onChange={(e) => setTodo(e.target.value)} />
          <textarea placeholder="Your preferences (kept for this deadline): hard work first, 10 min break every hour…" value={wish} onChange={(e) => setWish(e.target.value)} />
          <button type="button" disabled={busyAi} onClick={() => void arrange()}>{busyAi ? "Planning…" : "Arrange"}</button>
        </details>
      </div>
    </div>,
    document.body,
  );
}

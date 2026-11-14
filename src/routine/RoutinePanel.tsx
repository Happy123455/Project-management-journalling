import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { addDays, dayKey, dayTitle } from "../lib/timestamp";
import { showToast, showError } from "../lib/toast";
import {
  buckets, dayGap, freeMinutes, habitSeries, minuteClock, minutesText, newId, phaseOf, phaseSummaries, predict, restCheck, smooth, weekStart,
  type Habit, type RoutineConfig, type RoutineDayLog, type RoutineStep,
} from "../lib/routine";
import { saveConfig, useRoutine, writeLog, type RoutineView } from "./routineData";
import { useTodayAgenda, agendaAction } from "./agenda";
import { DayTimeline } from "./DayTimeline";
import { PhaseChart, TrendChart } from "./charts";
import { askHealthAccess, healthAvailable, importHealth } from "./health";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { StepIcon } from "./StepIcon";

type Tab = "now" | "trends" | "phases" | "setup";
const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 🧭 Routine: one-tap habits and steps, today's flow, trends, life phases and the setup. */
export function RoutinePanel({ store, onClose }: { store: JournalStore; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("now");
  const { view } = useRoutine(store);
  const { items } = useTodayAgenda(store);
  useEscapeToClose(onClose);
  // The phone: exercise and sleep come in from the health app when the panel opens.
  useEffect(() => {
    if (view?.config.health) void importHealth(store, view.config).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, view?.config.health]);
  return createPortal(
    <>
      <div className="outline-backdrop" onClick={onClose} />
      <aside className="routine-panel" role="dialog" aria-label="Routine">
        <header>
          <strong>🧭 Routine</strong>
          <nav>
            {(["now", "trends", "phases", "setup"] as Tab[]).map((t) => (
              <button key={t} type="button" className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {{ now: "Today", trends: "Trends", phases: "Phases", setup: "Setup" }[t]}
              </button>
            ))}
          </nav>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="routine-body">
          {!view ? (
            <p className="loading">Loading…</p>
          ) : tab === "now" ? (
            <NowTab store={store} view={view} agenda={items} />
          ) : tab === "trends" ? (
            <TrendsTab view={view} />
          ) : tab === "phases" ? (
            <PhasesTab store={store} view={view} />
          ) : (
            <SetupTab store={store} config={view.config} />
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

function NowTab({ store, view, agenda }: { store: JournalStore; view: RoutineView; agenda: ReturnType<typeof useTodayAgenda>["items"] }) {
  const { config, stats, filled, plan, day, now } = view;
  const care = useMemo(() => restCheck(view.days, config, stats, day), [view.days, config, stats, day]);
  const free = freeMinutes(day, filled, config, stats, plan, now);
  const todayLog = view.days.get(day);
  const open = config.steps.find((s) => (filled.get(s.id) ?? []).some((x) => x.open && !x.estimated && x.end >= now - 60_000));
  const next = plan[0] && config.steps.find((s) => s.id === plan[0].id);
  const tap = (item: { icon: string; label: string }, edge: "start" | "end" | "point") =>
    void writeLog(store, item, edge).then(() => showToast(`${item.icon} ${item.label}${edge === "point" ? "" : ` ${edge}`} · ${clock(Date.now())}`)).catch((e) => showError("Couldn't log it", e));
  return (
    <>
      {care && <p className="routine-care">🌿 {care}</p>}
      <p className="routine-now">
        {open ? (
          <>Now: {open.icon} {open.label} since {clock(filled.get(open.id)!.find((x) => x.open)!.start)}{stats.get(open.id)?.minutes ? ` · usually ${minutesText(stats.get(open.id)!.minutes)}` : ""}</>
        ) : next ? (
          <>Usually next: {next.icon} {next.label} around {clock(plan[0].start)}. No rush.</>
        ) : (
          <>Nothing else planned today. The rest is yours.</>
        )}
        {free !== null && <span className="routine-free"> · about {minutesText(free)} free before bed</span>}
      </p>

      <h3>Habits</h3>
      <div className="habit-grid">
        {config.habits.map((h) => (
          <button key={h.id} type="button" className="habit-tap" onClick={() => tap(h, "point")}>
            <span className="habit-icon"><StepIcon item={h} /></span>
            <span>{h.label}</span>
            <small>{todayLog?.habits.get(h.id)?.length ?? 0} today</small>
          </button>
        ))}
        {!config.habits.length && <p className="hint">Add habits in Setup.</p>}
      </div>

      <h3>Your day</h3>
      <ul className="routine-steps">
        {config.steps.map((s) => {
          const list = filled.get(s.id) ?? [];
          const going = list.find((x) => x.open && !x.estimated && x.end >= now - 60_000);
          const est = list.find((x) => x.estimated);
          const done = list.filter((x) => !x.estimated && !(x.open && x.end >= now - 60_000));
          const planned = plan.find((p) => p.id === s.id);
          const status = going
            ? `▶ since ${clock(going.start)}`
            : done.length
              ? `✓ ${done.map((x) => (s.span && x.end > x.start ? `${clock(x.start)}–${clock(x.end)}` : clock(x.start))).join(", ")}`
              : est
                ? `≈ ${clock(est.start)} · filled in`
                : planned
                  ? `~${clock(planned.start)}`
                  : "";
          return (
            <li key={s.id} className={going ? "going" : done.length ? "done" : est ? "estimated" : ""}>
              <span className="step-icon"><StepIcon item={s} /></span>
              <span className="step-label">{s.label}{s.health ? <small> ♥</small> : null}</span>
              <span className="step-status">{status}</span>
              <span className="step-actions">
                {!s.span ? (
                  <button type="button" onClick={() => tap(s, "point")} aria-label={`${s.label} now`}>✓</button>
                ) : going ? (
                  <button type="button" onClick={() => tap(s, "end")}>■ End</button>
                ) : (
                  <>
                    <button type="button" onClick={() => tap(s, "start")} aria-label={`Start ${s.label}`}>▶</button>
                    <button type="button" onClick={() => tap(s, "end")} aria-label={`${s.label} done`} title="Done now (its start is taken from how long it usually takes)">✓</button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <h3>Timeline</h3>
      <DayTimeline view={view} day={day} agenda={agenda} onReminder={(item) => !item.done && void agendaAction(store, item, "done")} />
      <p className="hint">Steps you didn't log are filled in (≈) from how long they usually take. Taps are written into today's note under [[Routine]], so you can fix any line by editing it.</p>
    </>
  );
}

type Range = "week" | "month" | "year";

function TrendsTab({ view }: { view: RoutineView }) {
  const { config, days, day } = view;
  const things = [...config.habits.map((h) => ({ id: h.id, icon: h.icon, label: h.label, habit: true })), ...config.steps.filter((s) => s.span).map((s) => ({ id: s.id, icon: s.icon, label: s.label, habit: false }))];
  const [pick, setPick] = useState(things[0]?.id ?? "");
  const [range, setRange] = useState<Range>("month");
  const thing = things.find((t) => t.id === pick) ?? things[0];
  // Steps count as the number of times they were logged (not filled in).
  const counts = useMemo(() => {
    if (!thing) return new Map<string, RoutineDayLog>();
    if (thing.habit) return days;
    const m = new Map<string, RoutineDayLog>();
    for (const [k, d] of days) m.set(k, { day: k, steps: new Map(), habits: new Map([[thing.id, (d.steps.get(thing.id) ?? []).filter((s) => !s.estimated).map((s) => s.start)]]) });
    return m;
  }, [days, thing]);
  if (!thing) return <p className="hint">Add a habit in Setup to see its trend.</p>;
  const yearFrom = addDays(day, -364);
  const daily = habitSeries(counts, thing.id, yearFrom, day);
  const sum = (from: string) => daily.slice(Math.max(0, dayGap(yearFrom, from))).reduce((a, b) => a + b, 0);
  const firstLogged = daily.findIndex((v) => v > 0);
  const weeksKnown = firstLogged < 0 ? 0 : Math.max(1, (daily.length - firstLogged) / 7);
  // The fit starts at the first day ever logged: the empty days before it aren't a trend.
  const since = (list: number[], firstIndexInList: number) => list.slice(Math.max(0, Math.min(list.length - 2, firstIndexInList)));
  let values: number[], labels: string[], ahead: number[], aheadLabels: string[], curve: number[];
  const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (range === "year") {
    // Whole weeks, Monday to Sunday, ending with this one (so far).
    const start = addDays(weekStart(day), -51 * 7);
    const series = habitSeries(counts, thing.id, start, day);
    values = buckets(series, 7);
    labels = values.map((_, i) => short(addDays(start, i * 7)));
    curve = smooth(values, 2);
    // This week isn't over: the fit uses the finished ones.
    const firstWeek = firstLogged < 0 ? 0 : Math.ceil(dayGap(start, addDays(yearFrom, firstLogged)) / 7);
    const fit = curve.slice(0, -1).map((v, i) => [v, i] as const).slice(-12);
    ahead = predict(since(fit.map(([v]) => v), firstWeek - fit[0][1]), 9).slice(1);
    aheadLabels = ahead.map((_, i) => short(addDays(start, (values.length + i) * 7)));
  } else {
    const n = range === "week" ? 7 : 30;
    values = daily.slice(-n);
    labels = values.map((_, i) => short(addDays(day, i - n + 1)));
    curve = smooth(values, range === "week" ? 1 : 2.5);
    const k = range === "week" ? 3 : 7;
    const recent = smooth(daily.slice(-28), 2.5).slice(0, -1);
    ahead = predict(since(recent, firstLogged < 0 ? 0 : firstLogged - (daily.length - 28)), k + 1).slice(1);
    aheadLabels = ahead.map((_, i) => short(addDays(day, i + 1)));
  }
  const lastWeeks = buckets(habitSeries(counts, thing.id, addDays(weekStart(day), -8 * 7), addDays(weekStart(day), -1)), 7);
  const nextWeek = predict(since(lastWeeks, firstLogged < 0 ? 0 : 8 - Math.floor(dayGap(addDays(yearFrom, firstLogged), weekStart(day)) / 7)), 2);
  return (
    <>
      <div className="trend-picks">
        {things.map((t) => (
          <button key={t.id} type="button" className={t.id === thing.id ? "active" : ""} onClick={() => setPick(t.id)}>{t.icon} {t.label}</button>
        ))}
      </div>
      <div className="trend-range">
        {(["week", "month", "year"] as Range[]).map((r) => (
          <button key={r} type="button" className={range === r ? "active" : ""} onClick={() => setRange(r)}>{{ week: "Week", month: "Month", year: "Year" }[r]}</button>
        ))}
      </div>
      <dl className="trend-stats">
        <div><dt>This week</dt><dd>{sum(weekStart(day))}</dd></div>
        <div><dt>This month</dt><dd>{sum(`${day.slice(0, 8)}01`)}</dd></div>
        <div><dt>This year</dt><dd>{sum(`${day.slice(0, 5)}01-01`)}</dd></div>
        <div><dt>Per week</dt><dd>{weeksKnown ? (daily.slice(firstLogged).reduce((a, b) => a + b, 0) / weeksKnown).toFixed(1) : "–"}</dd></div>
      </dl>
      <TrendChart values={values} curve={curve} ahead={ahead} labels={labels} aheadLabels={aheadLabels} />
      <p className="hint">
        Bars: times logged. Line: the smooth trend. Dashed: where it's heading if things go on like this
        {weeksKnown >= 2 ? ` (about ${Math.round(nextWeek[1] ?? 0)} next week)` : ""}. It's a description, not a target.
      </p>
    </>
  );
}

function PhasesTab({ store, view }: { store: JournalStore; view: RoutineView }) {
  const { config, days, day } = view;
  const current = phaseOf(day, config.phases);
  const [name, setName] = useState("");
  const [start, setStart] = useState(dayKey(new Date()));
  const summaries = useMemo(() => phaseSummaries(days, config, day), [days, config, day]);
  const save = (c: RoutineConfig) => void saveConfig(store, c).catch((e) => showError("Couldn't save", e));
  const fmt = (m: number | null) => (m === null ? "–" : minuteClock(m));
  return (
    <>
      <p className="routine-now">Now: <strong>{current?.name ?? "no phase set"}</strong>{current ? ` · since ${dayTitle(current.start)}` : ""}</p>
      <form
        className="phase-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !start) return;
          save({ ...config, phases: [...config.phases.filter((p) => p.start !== start), { id: newId("phase"), name: name.trim(), start }] });
          setName("");
          showToast(`New phase: ${name.trim()}`);
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New phase (e.g. College term)" aria-label="Phase name" />
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Starts on" />
        <button type="submit" disabled={!name.trim()}>Start</button>
      </form>
      <p className="hint">Times adapt to each phase from its own days. How long things take (brushing, a bath) carries over from every phase.</p>
      {summaries.some((s) => s.days) ? <PhaseChart summaries={summaries} config={config} /> : <p className="hint">Log a few days to see your usual day here.</p>}
      <table className="phase-table">
        <thead><tr><th>Phase</th><th>Days</th><th>Wake</th><th>Bed</th><th>Work</th><th>Free</th></tr></thead>
        <tbody>
          {summaries.map((s) => (
            <tr key={s.phase?.id ?? "none"}>
              <td>{s.name}</td><td>{s.days}</td><td>{fmt(s.wake)}</td><td>{fmt(s.sleep)}</td>
              <td>{s.work === null ? "–" : minutesText(s.work)}</td><td>{s.free === null ? "–" : minutesText(s.free)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {config.phases.length > 0 && (
        <ul className="phase-list">
          {[...config.phases].sort((a, b) => b.start.localeCompare(a.start)).map((p) => (
            <li key={p.id}>
              <span>{p.name} · from {p.start}</span>
              <button type="button" onClick={() => save({ ...config, phases: config.phases.filter((x) => x.id !== p.id) })} aria-label={`Remove ${p.name}`}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SetupTab({ store, config }: { store: JournalStore; config: RoutineConfig }) {
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const setStep = (i: number, patch: Partial<RoutineStep>) => setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setHabit = (i: number, patch: Partial<Habit>) => setDraft({ ...draft, habits: draft.habits.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  const move = (i: number, d: -1 | 1) => {
    const steps = [...draft.steps];
    if (i + d < 0 || i + d >= steps.length) return;
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    setDraft({ ...draft, steps });
  };
  // Hold ⠿ and drag a row up or down to reorder (steps or habits).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [dragging, setDragging] = useState<string | null>(null);
  const startDrag = (e: ReactPointerEvent, list: "steps" | "habits", id: string) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(id);
    navigator.vibrate?.(10);
    const move = (ev: PointerEvent) => {
      const over = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(`[data-${list}]`);
      const to = over ? Number(over.dataset[list]) : -1;
      const d = draftRef.current;
      const items = [...d[list]] as (RoutineStep | Habit)[];
      const from = items.findIndex((x) => x.id === id);
      if (to < 0 || from < 0 || to === from) return;
      const [it] = items.splice(from, 1);
      items.splice(to, 0, it);
      navigator.vibrate?.(5);
      setDraft({ ...d, [list]: items });
    };
    const end = () => {
      setDragging(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const pickGif = (apply: (gif: string | undefined) => void, has: boolean) => {
    if (has) return apply(undefined);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/gif,image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const r = await store.saveFile({ name: f.name || "icon.gif", mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
        apply(r.id);
      } catch (err) {
        showError("Couldn't add the GIF", err);
      }
    };
    input.click();
  };
  const save = async () => {
    // A renamed step or habit keeps its old name, so lines already written still count.
    const keep = <T extends { id: string; label: string; aliases?: string[] }>(list: T[], old: T[]) =>
      list.map((x) => {
        const was = old.find((o) => o.id === x.id);
        return was && was.label !== x.label && was.label.trim() ? { ...x, aliases: [...new Set([...(x.aliases ?? []), was.label])] } : x;
      }).filter((x) => x.label.trim());
    try {
      await saveConfig(store, { ...draft, steps: keep(draft.steps, config.steps), habits: keep(draft.habits, config.habits) });
      showToast("Saved");
    } catch (e) {
      showError("Couldn't save", e);
    }
  };
  return (
    <>
      <h3>Steps of your day <small>(in order)</small></h3>
      <ul className="setup-list">
        {draft.steps.map((s, i) => (
          <li key={s.id} data-steps={i} className={dragging === s.id ? "dragging" : ""}>
            <span className="setup-grip" onPointerDown={(e) => startDrag(e, "steps", s.id)} aria-label="Drag to reorder" title="Drag to reorder">⠿</span>
            {s.gif ? <span className="emoji setup-gif"><StepIcon item={s} /></span> : <input className="emoji" value={s.icon} onChange={(e) => setStep(i, { icon: e.target.value })} aria-label="Icon" />}
            <button type="button" className="setup-gif-btn" onClick={() => pickGif((gif) => setStep(i, { gif }), !!s.gif)} title={s.gif ? "Remove the GIF" : "Use a GIF as its icon"}>{s.gif ? "✕GIF" : "GIF"}</button>
            <input value={s.label} onChange={(e) => setStep(i, { label: e.target.value })} aria-label="Name" />
            <label title="Has a start and an end"><input type="checkbox" checked={s.span} onChange={(e) => setStep(i, { span: e.target.checked })} /> start/end</label>
            <label title="Ideal start time (optional)">ideal <input type="time" value={s.ideal ?? ""} onChange={(e) => setStep(i, { ideal: e.target.value || undefined })} /></label>
            <label title="Counts as work or study"><input type="checkbox" checked={!!s.work} onChange={(e) => setStep(i, { work: e.target.checked || undefined })} /> work</label>
            <span className="setup-move">
              <button type="button" onClick={() => move(i, -1)} aria-label="Earlier">↑</button>
              <button type="button" onClick={() => move(i, 1)} aria-label="Later">↓</button>
              <button type="button" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })} aria-label="Remove">✕</button>
            </span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { id: newId("step"), label: "New step", icon: "⭐", span: true, minutes: 15 }] })}>+ Step</button>

      <h3>Habits <small>(one tap each)</small></h3>
      <ul className="setup-list">
        {draft.habits.map((h, i) => (
          <li key={h.id} data-habits={i} className={dragging === h.id ? "dragging" : ""}>
            <span className="setup-grip" onPointerDown={(e) => startDrag(e, "habits", h.id)} aria-label="Drag to reorder" title="Drag to reorder">⠿</span>
            {h.gif ? <span className="emoji setup-gif"><StepIcon item={h} /></span> : <input className="emoji" value={h.icon} onChange={(e) => setHabit(i, { icon: e.target.value })} aria-label="Icon" />}
            <button type="button" className="setup-gif-btn" onClick={() => pickGif((gif) => setHabit(i, { gif }), !!h.gif)} title={h.gif ? "Remove the GIF" : "Use a GIF as its icon"}>{h.gif ? "✕GIF" : "GIF"}</button>
            <input value={h.label} onChange={(e) => setHabit(i, { label: e.target.value })} aria-label="Name" />
            <button type="button" onClick={() => setDraft({ ...draft, habits: draft.habits.filter((_, j) => j !== i) })} aria-label="Remove">✕</button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setDraft({ ...draft, habits: [...draft.habits, { id: newId("habit"), label: "New habit", icon: "✨" }] })}>+ Habit</button>

      <h3>Gentle by design</h3>
      <label className="setup-toggle"><input type="checkbox" checked={!!draft.quiet} onChange={(e) => setDraft({ ...draft, quiet: e.target.checked || undefined })} /> Quiet mode: no "later than usual", no comparisons. Just the log and the plan.</label>
      <label className="setup-toggle"><input type="checkbox" checked={!!draft.nudges} onChange={(e) => setDraft({ ...draft, nudges: e.target.checked || undefined })} /> Soft nudges: a quiet notification when a step usually starts (never a "you're late").</label>
      <label className="setup-toggle">
        <input
          type="checkbox"
          checked={!!draft.health}
          disabled={!healthAvailable() && !draft.health}
          onChange={(e) => {
            setDraft({ ...draft, health: e.target.checked || undefined });
            if (e.target.checked) void askHealthAccess();
          }}
        />{" "}
        Samsung Health: exercise and sleep come in by themselves (on the phone, through Health Connect).
        {!healthAvailable() && <small> Only on the phone.</small>}
      </label>
      <div className="setup-save">
        <button type="button" disabled={!dirty} onClick={() => setDraft(config)}>Undo changes</button>
        <button type="button" className="primary" disabled={!dirty} onClick={() => void save()}>Save</button>
      </div>
    </>
  );
}

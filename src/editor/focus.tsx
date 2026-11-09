import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { clock, hm } from "../lib/deadline";
import { fx } from "../lib/fx";
import { showToast } from "../lib/toast";
import { changePlansAnywhere } from "./deadlineStore";

/**
 * ▶ Focus on a plan: a small floating pill counts the time; Stop records the session on the plan
 * (plan vs actual, progress), Done also ticks it off. Kept in localStorage so it survives a restart.
 */
export interface FocusRun {
  note: string;
  tid: string;
  planId: string;
  title: string;
  startedAt: number;
  planEnd: number;
}

const KEY = "journal.focus";
const listeners = new Set<() => void>();
let run: FocusRun | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
})();
function setRun(next: FocusRun | null) {
  run = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode.
  }
  listeners.forEach((f) => f());
}
export const useFocus = () => useSyncExternalStore((f) => (listeners.add(f), () => void listeners.delete(f)), () => run);

let storeRef: JournalStore | null = null;

export function startFocus(r: Omit<FocusRun, "startedAt">) {
  if (run) void stopFocus(false);
  fx("start");
  setRun({ ...r, startedAt: Date.now() });
}

export async function stopFocus(done: boolean) {
  const r = run;
  if (!r) return;
  setRun(null);
  fx(done ? "done" : "stop");
  const end = Date.now();
  if (!storeRef || end - r.startedAt < 30_000) return void (done || showToast("Focus under 30 s isn't recorded"));
  await changePlansAnywhere(storeRef, r.note, r.tid, (plans) => plans.map((p) => (p.id === r.planId ? { ...p, done: done || p.done, actual: [...(p.actual ?? []), { start: r.startedAt, end }] } : p)));
  showToast(`${done ? "✓ " : ""}${r.title}: ${hm(end - r.startedAt)} focused`);
}

/** The floating focus pill (App mounts it once). */
export function FocusHost({ store }: { store: JournalStore }) {
  storeRef = store;
  const r = useFocus();
  const [now, setNow] = useState(Date.now());
  const [warned, setWarned] = useState(false);
  useEffect(() => {
    if (!r) return;
    setWarned(false);
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [r]);
  useEffect(() => {
    if (r && !warned && now >= r.planEnd && r.planEnd > r.startedAt) {
      setWarned(true);
      fx("warn");
      showToast(`⏰ Planned time for ${r.title} is up`);
    }
  }, [now, r, warned]);
  if (!r) return null;
  const spent = Math.max(0, now - r.startedAt);
  const total = Math.max(1, r.planEnd - r.startedAt);
  const s = Math.floor(spent / 1000);
  const time = `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return createPortal(
    <div className={`focus-pill${now > r.planEnd ? " over" : ""}`} role="timer" aria-label={`Focusing on ${r.title}`}>
      <i className="focus-ring" style={{ ["--p" as string]: `${Math.min(100, (spent / total) * 100)}%` }} />
      <span className="focus-text">
        <b>{r.title}</b>
        <small>{time}{r.planEnd > now ? ` · until ${clock(r.planEnd)}` : " · over time"}</small>
      </span>
      <button type="button" onClick={() => void stopFocus(false)} aria-label="Stop">■</button>
      <button type="button" className="primary" onClick={() => void stopFocus(true)} aria-label="Done">✓</button>
    </div>,
    document.body,
  );
}

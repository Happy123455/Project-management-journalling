import { useCallback, useEffect, useState } from "react";
import type { JournalStore } from "../store";
import { DONE_MARK, timeEdit, todayAgenda, type AgendaItem } from "../lib/reminders";
import { addDays, dayKey } from "../lib/timestamp";
import { visibleInterval } from "../lib/power";
import { showError, showToast } from "../lib/toast";
import { currentDoc, editDayLine, ROUTINE_EVENT } from "./routineData";

/** Today's timed reminders, kept current (after edits, sync, and once a minute while visible). */
export function useTodayAgenda(store: JournalStore | null, active = true) {
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    if (!store) return;
    const today = dayKey(new Date());
    const [doc, page, reminders] = await Promise.all([currentDoc(store, today), store.getDay(today), store.openReminders()]);
    const repeating = reminders.filter((r) => r.props.repeat).map((r) => ({ day: r.day, content: r.content, repeat: r.props.repeat, doneDays: r.props.doneDays }));
    setItems(todayAgenda(doc ? { content: doc, reminder: !!page?.props.reminder } : null, repeating, today));
    setNow(Date.now());
  }, [store]);
  useEffect(() => {
    if (!active) return;
    void load();
    let t: number | undefined;
    const soon = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void load(), 200);
    };
    window.addEventListener(ROUTINE_EVENT, soon);
    window.addEventListener("journal:synced", soon);
    // Typing a "⏰ 15:00" line shows up without reopening anything.
    const stop = visibleInterval(() => void load(), 30_000);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener(ROUTINE_EVENT, soon);
      window.removeEventListener("journal:synced", soon);
      stop();
    };
  }, [load, active]);
  return { items, now, reload: load };
}

export type AgendaAction = "done" | "undo" | 15 | 60;

/** Tick off a reminder, or move it later today. Repeats are ticked off for today only. */
export async function agendaAction(store: JournalStore, item: AgendaItem, action: AgendaAction) {
  const today = dayKey(new Date());
  try {
    if (action === "done" || action === "undo") {
      if (item.repeat) {
        const page = await store.getDay(item.day);
        const kept = (page?.props.doneDays ?? []).filter((d) => d >= addDays(today, -30) && d !== today);
        await store.setDayProps(item.day, { doneDays: action === "done" ? [...kept, today] : kept.length ? kept : undefined });
      } else if (action === "done") await editDayLine(store, item.day, item.line, { index: 0, del: 0, ins: DONE_MARK });
      else {
        const m = /^\s*✅\s*/.exec(item.line);
        if (m) await editDayLine(store, item.day, item.line, { index: 0, del: m[0].length, ins: "" });
      }
      if (action === "done") showToast("✓ Done");
    } else {
      // From now (or its time, if that's still ahead), rounded to 5 minutes.
      const base = Math.max(Date.now(), item.at) + action * 60_000;
      const d = new Date(Math.ceil(base / 300_000) * 300_000);
      if (dayKey(d) !== today) return showToast("That would be tomorrow: move it from Coming up instead");
      const ok = await editDayLine(store, item.day, item.line, timeEdit(item.line, d.getHours(), d.getMinutes()));
      if (ok) showToast(`⏰ Moved to ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    }
    window.dispatchEvent(new Event(ROUTINE_EVENT));
  } catch (e) {
    showError("Couldn't change the reminder", e);
  }
}

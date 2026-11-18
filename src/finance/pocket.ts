import type { JournalStore } from "../store";
import { addDays, dayKey } from "../lib/timestamp";
import { withLogLine } from "../lib/routine";
import { insertLogLinePM, openDayEditor } from "../editor/noteEdit";
import { changeDay } from "../routine/routineData";
import { pocketIn, pocketLine, pocketState, POCKET_BOX, type PocketEntry, type PocketKind, type PocketState } from "../lib/pocket";
import { rupees } from "../lib/finance";
import { FINANCE_EVENT } from "./capture";

/**
 * 👛 Pocket (src/lib/pocket.ts): reads the [[pocket]] boxes of the day notes and writes new lines
 * into today's box. What the AI agent writes goes in under its own name, so it can be undone.
 */

const parsed = new Map<string, { stamp: string; list: PocketEntry[] }>();

/** Every pocket entry in the last ~400 days of notes. */
export async function loadPocket(store: JournalStore, today = dayKey(new Date())): Promise<PocketEntry[]> {
  const from = addDays(today, -400);
  const out: PocketEntry[] = [];
  for (const day of await store.listDays()) {
    if (day < from) continue;
    const editor = openDayEditor(day);
    if (editor) {
      out.push(...pocketIn(editor.getJSON(), day));
      continue;
    }
    const page = await store.getDay(day);
    const stamp = page?.updatedAt ?? "";
    const hit = parsed.get(day);
    if (hit && stamp && hit.stamp === stamp) {
      out.push(...hit.list);
      continue;
    }
    const list = pocketIn(page?.content ?? null, day);
    if (stamp) parsed.set(day, { stamp, list });
    out.push(...list);
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function pocketNow(store: JournalStore): Promise<PocketState> {
  return pocketState(await loadPocket(store));
}

/** One line in today's (or `day`'s) [[pocket]] box; the box is made at the end of the note if there's none. */
export async function addPocket(store: JournalStore, entry: { kind: PocketKind; amount: number; what: string }, opts: { day?: string; actor?: string } = {}): Promise<{ line: string; day: string }> {
  const day = opts.day ?? dayKey(new Date());
  const line = pocketLine(entry.kind, entry.amount, entry.what);
  await changeDay(
    store,
    day,
    (e) => (insertLogLinePM(e, line, POCKET_BOX, opts.actor), true),
    (doc) => withLogLine(doc, line, POCKET_BOX),
    opts.actor,
  );
  window.dispatchEvent(new CustomEvent(FINANCE_EVENT, { detail: { pocket: true } }));
  return { line, day };
}

/** "₹890 in your pocket" / "₹400 spent from your pocket today". */
export function pocketSummary(s: PocketState): string {
  const parts: string[] = [];
  if (s.balance !== null) parts.push(`${rupees(s.balance, 0)} left in your pocket`);
  if (s.spentToday) parts.push(`${rupees(s.spentToday, 0)} spent from it today`);
  if (s.balance === null) parts.push(`${rupees(s.spentMonth, 0)} spent in cash this month (count your wallet once in 💰 → Pocket to see what's left)`);
  return parts.join(", ");
}

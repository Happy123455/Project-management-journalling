import type { JournalStore } from "../store";
import { addDays, dayKey } from "../lib/timestamp";
import { withLogLine } from "../lib/routine";
import { insertLogLinePM, openDayEditor } from "../editor/noteEdit";
import { changeDay } from "../routine/routineData";
import { BANK_BOX, bankIn, bankLine, type BankEntry } from "../lib/bank";
import { FINANCE_EVENT } from "./capture";

/** 🏦 Bank balance (src/lib/bank.ts): reads the [[bank]] boxes of the day notes, writes into today's. */
const parsed = new Map<string, { stamp: string; list: BankEntry[] }>();

export async function loadBank(store: JournalStore, today = dayKey(new Date())): Promise<BankEntry[]> {
  const from = addDays(today, -800);
  const out: BankEntry[] = [];
  for (const day of await store.listDays()) {
    if (day < from) continue;
    const editor = openDayEditor(day);
    if (editor) {
      out.push(...bankIn(editor.getJSON(), day));
      continue;
    }
    const page = await store.getDay(day);
    const stamp = page?.updatedAt ?? "";
    const hit = parsed.get(day);
    if (hit && stamp && hit.stamp === stamp) {
      out.push(...hit.list);
      continue;
    }
    const list = bankIn(page?.content ?? null, day);
    if (stamp) parsed.set(day, { stamp, list });
    out.push(...list);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A new balance line in today's [[bank]] box (made at the end of the note if there's none). */
export async function addBank(store: JournalStore, entry: { account: string; amount: number }, opts: { day?: string; actor?: string } = {}): Promise<{ line: string; day: string }> {
  const day = opts.day ?? dayKey(new Date());
  const line = bankLine(entry.account, entry.amount);
  await changeDay(
    store,
    day,
    (e) => (insertLogLinePM(e, line, BANK_BOX, opts.actor), true),
    (doc) => withLogLine(doc, line, BANK_BOX),
    opts.actor,
  );
  window.dispatchEvent(new CustomEvent(FINANCE_EVENT, { detail: { bank: true } }));
  return { line, day };
}

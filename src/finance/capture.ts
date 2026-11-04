import type { JSONContent } from "@tiptap/react";
import type { DayPage, JournalStore } from "../store";
import { addDays, dayKey } from "../lib/timestamp";
import { alreadyHave, FINANCE_BOX, parseMessage, txnLine, txnsIn, type Txn } from "../lib/finance";
import { withLogLine } from "../lib/routine";
import { insertLogLinePM, openDayEditor } from "../editor/noteEdit";
import { changeDay, currentDoc } from "../routine/routineData";

/**
 * The phone's side of the money tracker: bank SMS alerts and payment-app notifications (Google Pay,
 * PhonePe, Paytm, BHIM…) become lines in that day's note (src/lib/finance.ts). Read on the phone
 * only (MainActivity.kt FinanceBridge); the Mac sees them through sync.
 */

declare global {
  interface Window {
    JournalFinance?: {
      smsStatus(): string;
      askSms(): void;
      readSms(id: string, from: number): void;
      notifyStatus(): string;
      openNotifyAccess(): void;
      notifications(): string;
      clearNotifications(upTo: number): void;
    };
    __journalFinance?: (id: string, json: string) => void;
  }
}

export const FINANCE_EVENT = "journal:finance";
const ACTOR = "Money tracker";

export interface MoneySettings {
  /** Read bank SMS alerts. */
  sms: boolean;
  /** Keep payment-app notifications. */
  notifications: boolean;
  /** Messages up to this time (ms) have been read. */
  lastSms: number;
}

const KEY = "journal.money";
export function moneySettings(): MoneySettings {
  try {
    return { sms: false, notifications: false, lastSms: 0, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { sms: false, notifications: false, lastSms: 0 };
  }
}
export function setMoneySettings(patch: Partial<MoneySettings>): MoneySettings {
  const next = { ...moneySettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Lasts for this session.
  }
  window.dispatchEvent(new Event(FINANCE_EVENT));
  return next;
}

export const onPhone = () => !!window.JournalFinance;
const status = (f: "smsStatus" | "notifyStatus") => {
  try {
    return window.JournalFinance?.[f]() ?? "unavailable";
  } catch {
    return "unavailable";
  }
};
export const smsReady = () => status("smsStatus") === "ready";
export const notificationsReady = () => status("notifyStatus") === "ready";

const waiting = new Map<string, (json: string) => void>();
function readSms(from: number): Promise<{ sender: string; body: string; at: number }[] | null> {
  const bridge = window.JournalFinance;
  if (!bridge || !smsReady()) return Promise.resolve(null);
  window.__journalFinance = (id, json) => {
    waiting.get(id)?.(json);
    waiting.delete(id);
  };
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => (waiting.delete(id), resolve(null)), 30_000);
    waiting.set(id, (json) => {
      window.clearTimeout(timer);
      try {
        const list = JSON.parse(json);
        resolve(Array.isArray(list) ? list : null);
      } catch {
        resolve(null);
      }
    });
    bridge.readSms(id, from);
  });
}

function readNotifications(): { app: string; title: string; text: string; at: number }[] {
  try {
    const list = JSON.parse(window.JournalFinance?.notifications() ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let running: Promise<number> | null = null;

/** Writes new transactions into the notes. `since` (ms) reads further back than last time (the "bring in" button). */
export function importMoney(store: JournalStore, since?: number): Promise<number> {
  if (running) return running;
  running = (async () => {
    const s = moneySettings();
    const found: Txn[] = [];
    let smsUpTo = s.lastSms;
    if (s.sms && smsReady()) {
      const from = since ?? (s.lastSms || Date.now() - 2 * 86_400_000);
      const msgs = await readSms(from);
      if (msgs) {
        for (const m of msgs) {
          const t = parseMessage(m.body, m.at, m.sender, "sms");
          if (t) found.push(t);
          smsUpTo = Math.max(smsUpTo, m.at);
        }
        if (!msgs.length) smsUpTo = Math.max(smsUpTo, from);
      }
    }
    let noteUpTo = 0;
    if (s.notifications && notificationsReady()) {
      for (const n of readNotifications()) {
        const t = parseMessage(`${n.title}. ${n.text}`, n.at, n.app, "notification");
        if (t) found.push(t);
        noteUpTo = Math.max(noteUpTo, n.at);
      }
    }
    // SMS first, so a bank's message (with its reference) is the one kept when both arrive.
    found.sort((a, b) => (a.source === b.source ? a.at - b.at : a.source === "sms" ? -1 : 1));
    const byDay = new Map<string, Txn[]>();
    for (const t of found) {
      const day = dayKey(new Date(t.at));
      byDay.set(day, [...(byDay.get(day) ?? []), t]);
    }
    let added = 0;
    for (const [day, list] of byDay) {
      // The day before and after too: a notification at 23:58 and its SMS at 00:01.
      const have = [...txnsIn(await currentDoc(store, day), day), ...txnsIn(await currentDoc(store, addDays(day, -1)), addDays(day, -1)), ...txnsIn(await currentDoc(store, addDays(day, 1)), addDays(day, 1))];
      const lines: string[] = [];
      for (const t of list) {
        if (alreadyHave(t, have)) continue;
        have.push(t);
        lines.push(txnLine(t));
      }
      if (!lines.length) continue;
      lines.sort();
      const ok = await changeDay(
        store,
        day,
        (e) => (lines.forEach((l) => insertLogLinePM(e, l, FINANCE_BOX)), true),
        (doc) => lines.reduce<JSONContent>((d, l) => withLogLine(d, l, FINANCE_BOX), doc ?? { type: "doc", content: [] }),
        ACTOR,
      );
      if (ok) added += lines.length;
    }
    setMoneySettings({ lastSms: smsUpTo });
    try {
      if (noteUpTo) window.JournalFinance?.clearNotifications(noteUpTo);
    } catch {
      // Taken again next time; duplicates are skipped.
    }
    if (added) window.dispatchEvent(new CustomEvent(FINANCE_EVENT, { detail: { added } }));
    return added;
  })().finally(() => (running = null));
  return running;
}

let last = 0;

/** Phone: brings in new transactions when the journal opens or comes back (at most every 3 minutes). */
export function startMoneySync(store: JournalStore): () => void {
  if (!window.JournalFinance) return () => {};
  const run = () => {
    const s = moneySettings();
    if (document.visibilityState === "hidden" || (!s.sms && !s.notifications) || Date.now() - last < 3 * 60_000) return;
    last = Date.now();
    void importMoney(store).catch(() => {});
  };
  const t = window.setTimeout(run, 5000);
  document.addEventListener("visibilitychange", run);
  return () => {
    window.clearTimeout(t);
    document.removeEventListener("visibilitychange", run);
  };
}

// Parsed notes are kept between loads: only days whose note changed are read again.
const parsed = new Map<string, { stamp: string; txns: Txn[] }>();

/** Every transaction in the notes of the last ~400 days. */
export async function loadTxns(store: JournalStore, today = dayKey(new Date())): Promise<Txn[]> {
  const from = addDays(today, -400);
  const out: Txn[] = [];
  for (const day of await store.listDays()) {
    if (day < from) continue;
    const editor = openDayEditor(day);
    if (editor) {
      out.push(...txnsIn(editor.getJSON(), day));
      continue;
    }
    const page: DayPage | null = await store.getDay(day);
    const stamp = page?.updatedAt ?? "";
    const hit = parsed.get(day);
    if (hit && stamp && hit.stamp === stamp) {
      out.push(...hit.txns);
      continue;
    }
    const txns = txnsIn(page?.content ?? null, day);
    if (stamp) parsed.set(day, { stamp, txns });
    out.push(...txns);
  }
  return out.sort((a, b) => a.at - b.at);
}

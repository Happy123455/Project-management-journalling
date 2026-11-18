import type { JSONContent } from "@tiptap/react";
import { pocketAmount, pocketWhat } from "./pocket";
import { TIMESTAMP_RE } from "./timestamp";

/**
 * 🏦 Bank balance (Hapi, 18 Nov): what the bank account holds, typed in by hand now and then, kept
 * apart from the 👛 pocket (cash). Written like the pocket, in day notes under a [[bank]] line:
 *   [[bank]]
 *     Bank balance: 45230
 *     HDFC: 12000
 * Each line sets that account's balance at that time (the line's timestamp, else the day). The
 * newest line per account is what it holds now; the older ones are its history.
 */
export const BANK_BOX = "[[bank]]";
const isBankTitle = (text: string) => /\[\[\s*bank\s*(?:\|[^\]]*)?\]\]/i.test(text);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface BankEntry {
  account: string;
  amount: number;
  day: string;
  at: number;
  line: string;
}

/** "Bank balance: 45,230" → { account: "Bank", amount: 45230 }. */
export function readBankLine(line: string, day: string, order = 0): BankEntry | null {
  const amount = pocketAmount(line);
  if (amount === null) return null;
  const raw = pocketWhat(line).replace(/\b(?:balance|bal|now|is|in|account|a\/c)\b/gi, " ").replace(/\s+/g, " ").trim();
  const account = raw && !/^(?:bank|my bank)$/i.test(raw) ? raw.slice(0, 40) : "Bank";
  const ts = new RegExp(TIMESTAMP_RE.source).exec(line);
  let at: number;
  if (ts) at = new Date(Number(ts[3]), MONTHS.indexOf(ts[2]), Number(ts[1]), Number(ts[5]), Number(ts[6]), Number(ts[7])).getTime();
  else {
    const [y, mo, d] = day.split("-").map(Number);
    at = new Date(y, mo - 1, d, 12).getTime() + order;
  }
  return { account, amount, day, at, line };
}

/** Every bank line in a day's note, in the order written. */
export function bankIn(doc: JSONContent | null | undefined, day: string): BankEntry[] {
  const out: BankEntry[] = [];
  const blocks = doc?.content ?? [];
  const textOf = (b: JSONContent): string => (b.text ?? "") + (b.content ?? []).map(textOf).join("");
  const push = (text: string) => {
    const e = readBankLine(text, day, out.length);
    if (e) out.push(e);
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "codeBlock") continue;
    const text = textOf(b);
    if (!isBankTitle(text)) continue;
    if (pocketAmount(text) !== null) push(text);
    const level = Number(b.attrs?.indent ?? 0);
    let j = i + 1;
    for (; j < blocks.length && Number(blocks[j].attrs?.indent ?? 0) > level; j++) {
      if (blocks[j].type === "paragraph") push(textOf(blocks[j]));
      else if (/List$/.test(blocks[j].type ?? "")) for (const item of blocks[j].content ?? []) push(textOf(item));
    }
    if (j === i + 1 && /List$/.test(blocks[j]?.type ?? "")) for (const item of blocks[j].content ?? []) push(textOf(item));
    i = j - 1;
  }
  return out;
}

export interface BankState {
  /** Newest balance per account. */
  accounts: { account: string; amount: number; at: number; change: number | null }[];
  total: number | null;
  /** Every entry, newest first, with the change from that account's entry before it. */
  history: (BankEntry & { change: number | null })[];
  /** The total after each entry, oldest first (for the line chart). */
  totals: { at: number; total: number }[];
}

export function bankState(entries: BankEntry[]): BankState {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const last = new Map<string, BankEntry>();
  const history: BankState["history"] = [];
  const totals: BankState["totals"] = [];
  const prevChange = new Map<string, number | null>();
  for (const e of sorted) {
    const key = e.account.toLowerCase();
    const before = last.get(key);
    const change = before ? e.amount - before.amount : null;
    history.push({ ...e, change });
    prevChange.set(key, change);
    last.set(key, e);
    totals.push({ at: e.at, total: [...last.values()].reduce((s, x) => s + x.amount, 0) });
  }
  const accounts = [...last.entries()].map(([k, e]) => ({ account: e.account, amount: e.amount, at: e.at, change: prevChange.get(k) ?? null })).sort((a, b) => b.amount - a.amount);
  return { accounts, total: accounts.length ? accounts.reduce((s, a) => s + a.amount, 0) : null, history: history.reverse(), totals };
}

/** The line written for a new balance. */
export function bankLine(account: string, amount: number): string {
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const a = account.replace(/[:\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `${a && !/^bank$/i.test(a) ? a : "Bank balance"}: ${n}`;
}

/** "bank balance 45230", "my bank balance is ₹45,230", "HDFC balance 12000" → the entry, or null. */
export function bankFromSentence(text: string): { account: string; amount: number } | null {
  const m = /^\s*(?:set\s+|update\s+)?(?:my\s+)?(?:(\w[\w ]{0,20}?)\s+)?(?:bank\s+)?(?:balance|bal)\b(?:\s+(?:is|now|to|=|:))*\s*(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:rs|rupees?|₹)?\s*$/i.exec(text);
  if (!m || !/\bbank\b|\bbalance\b/i.test(text)) return null;
  if (!/\bbank\b/i.test(text) && !m[1]) return null;
  const amount = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const acc = (m[1] ?? "").replace(/\b(?:my|the|bank)\b/gi, "").trim();
  return { account: acc || "Bank", amount };
}

/**
 * 🔁 Monthly subscriptions (Hapi, 25 Nov: "keep track of my monthly subscription, a dashboard for the
 * month"). Two sources: ones Hapi adds by hand (kept in the app file subscriptions.json, synced), and
 * ones found in the money tracker: the same payee paid a similar amount about a month apart, or a
 * known subscription name. Each is matched to this month's payment to show paid / due.
 */
import type { Txn } from "./finance";

export interface Subscription {
  id: string;
  name: string;
  amount: number;
  /** Day of the month it renews (1–31). */
  day: number;
  cycle: "monthly" | "yearly";
  /** Words that find its payment in the tracked money ("netflix", "google"). */
  match?: string;
  /** Found from payments, not added by hand. */
  found?: boolean;
  /** Hidden by Hapi (a found one that isn't a subscription). */
  off?: boolean;
}

export const KNOWN = /netflix|spotify|youtube ?premium|google ?one|google ?ai|gemini|chatgpt|openai|claude|anthropic|icloud|apple\.com|apple ?music|prime|hotstar|jiocinema|jio ?hotstar|sonyliv|zee5|notion|canva|adobe|microsoft|office ?365|github|linkedin|duolingo|cult\.?fit|gym|airtel|jio\b|vi\b|broadband|recharge/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Payees paid a similar amount at least twice, 25–35 days apart (or a known name): likely subscriptions. */
export function findSubscriptions(txns: Txn[]): Subscription[] {
  const by = new Map<string, Txn[]>();
  for (const t of txns) {
    if (t.direction !== "debit" || !t.party || t.method === "cash") continue;
    const k = norm(t.party);
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), t]);
  }
  const out: Subscription[] = [];
  for (const [k, list] of by) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    const last = sorted[sorted.length - 1];
    let monthly = false;
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].at - sorted[i - 1].at) / 86_400_000;
      if (gap >= 25 && gap <= 35 && Math.abs(sorted[i].amount - sorted[i - 1].amount) <= Math.max(5, sorted[i].amount * 0.1)) monthly = true;
    }
    if (!monthly && !(KNOWN.test(k) && last.amount < 5000)) continue;
    out.push({ id: `found:${k}`, name: last.party!, amount: last.amount, day: new Date(last.at).getDate(), cycle: "monthly", match: k, found: true });
  }
  return out.sort((a, b) => a.day - b.day);
}

/** Hand-added ones win over found ones with the same match; hidden ones are dropped. */
export function mergeSubscriptions(saved: Subscription[], found: Subscription[]): Subscription[] {
  const ids = new Set(saved.map((s) => s.id));
  const matches = new Set(saved.map((s) => norm(s.match || s.name)));
  return [...saved, ...found.filter((f) => !ids.has(f.id) && !matches.has(f.match ?? ""))].filter((s) => !s.off).sort((a, b) => a.day - b.day);
}

export interface SubMonth {
  sub: Subscription;
  /** This month's renewal date (yyyy-mm-dd), clamped to the month's last day; null for a yearly one not due this month. */
  due: string | null;
  /** The payment found for it this month. */
  paid: Txn | null;
  /** What it costs per month (yearly ÷ 12). */
  perMonth: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function monthView(subs: Subscription[], txns: Txn[], year: number, month0: number): { rows: SubMonth[]; total: number; paid: number; due: number; perYear: number } {
  const last = new Date(year, month0 + 1, 0).getDate();
  const start = new Date(year, month0, 1).getTime();
  const end = new Date(year, month0 + 1, 1).getTime();
  const rows = subs.map((sub) => {
    const day = Math.min(sub.day, last);
    const due = `${year}-${pad(month0 + 1)}-${pad(day)}`;
    const key = norm(sub.match || sub.name);
    const paid =
      txns.find((t) => t.direction === "debit" && t.at >= start && t.at < end && !!t.party && (norm(t.party).includes(key) || key.includes(norm(t.party))) && Math.abs(t.amount - sub.amount) <= Math.max(5, sub.amount * 0.15)) ?? null;
    return { sub, due, paid, perMonth: sub.cycle === "yearly" ? sub.amount / 12 : sub.amount };
  });
  const total = rows.reduce((s, r) => s + r.perMonth, 0);
  const paid = rows.reduce((s, r) => s + (r.paid ? r.paid.amount : 0), 0);
  return { rows, total, paid, due: Math.max(0, rows.filter((r) => !r.paid && r.sub.cycle === "monthly").reduce((s, r) => s + r.sub.amount, 0)), perYear: total * 12 };
}

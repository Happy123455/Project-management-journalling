/**
 * 🏦 Bank statement history (Hapi, 18 Nov): import the PDF statement the bank gives (Axis layout:
 * Tran Date · Chq No · Particulars · Debit · Credit · Balance · Init. Br), keep every entry with the
 * balance after it, and let the Bank tab scroll back in time. Parsing works on pdf.js text items
 * (page, x, y, text) so it is plain and testable; src/finance/bankStatement.ts reads the PDF.
 *
 * The statement stays on the device (and Hapi's own sync folder) as the file bank-statement.json.
 */

export interface PdfItem {
  page: number;
  x: number;
  /** pdf.js y: grows upwards. */
  y: number;
  str: string;
}

export interface StatementTxn {
  /** "2026-08-24" */
  day: string;
  /** Position within the statement, to keep same-day entries in order. */
  order: number;
  /** Signed: + credit, − debit. */
  amount: number;
  /** Balance after this entry. */
  balance: number;
  /** The particulars as printed (lines joined). */
  text: string;
  /** Who or what, short ("Zomato", "Self cash deposit", "Interest"). */
  who: string;
  /** UPI/IMPS reference when there is one, to spot the same entry in two statements. */
  ref?: string;
}

export interface ParsedStatement {
  account?: string;
  from?: string;
  to?: string;
  opening: number | null;
  closing: number | null;
  txns: StatementTxn[];
  /** Entries whose balance didn't follow from the one before (a misread row). */
  mismatches: number;
}

export interface SavedStatements {
  version: 1;
  account?: string;
  periods: { from?: string; to?: string; opening: number | null; closing: number | null; importedAt: number; count: number }[];
  txns: StatementTxn[];
}

const DATE_RE = /^(\d{2})[-/](\d{2})[-/](\d{4})$/;
const MONEY_RE = /^-?[\d,]+\.\d{2}$/;
const money = (s: string) => Number(s.replace(/,/g, ""));
const toDay = (s: string) => {
  const m = DATE_RE.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** "UPI/P2M/631319214820/Zomato /UPIInt/HDFC BANK LTD" → { who: "Zomato", ref }. */
export function describe(text: string): { who: string; ref?: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const upi = /^UPI\/(P2[AMV])\/(\d{6,})\/([^/]*)/i.exec(t);
  if (upi) {
    let who = upi[3].trim();
    if (/^google pl/i.test(who)) who = "Google Play";
    else if (/^google in/i.test(who)) who = "Google India";
    return { who: titleCase(who) || "UPI", ref: upi[2] };
  }
  if (/^SELF CASH DEP/i.test(t)) return { who: "Cash deposit" };
  if (/Int\.?\s*Pd/i.test(t)) return { who: "Interest" };
  if (/^(?:ATM|CWDR|NWD)/i.test(t)) return { who: "ATM cash" };
  const imps = /^(IMPS|NEFT|RTGS)\/(?:[A-Z0-9]+\/)?(\d{6,})?\/?([^/]*)/i.exec(t);
  if (imps) return { who: `${imps[1].toUpperCase()} ${titleCase(imps[3] ?? "")}`.trim(), ref: imps[2] };
  return { who: titleCase(t.split("/").find((p) => /[a-z]{3}/i.test(p)) ?? t).slice(0, 40) };
}

function titleCase(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Reads the transaction table out of a statement's text items. */
export function parseStatement(items: PdfItem[]): ParsedStatement {
  const all = items.filter((i) => i.str.trim());
  const head = all.find((i) => /Statement of .*Account No/i.test(i.str));
  const period = head && /From:\s*(\S+)\s*To:\s*(\S+)\)?/i.exec(head.str);
  const accNo = head && /Account No:?\s*(\d+)/i.exec(head.str);
  const out: ParsedStatement = {
    account: accNo ? `Axis ··${accNo[1].slice(-4)}` : undefined,
    from: period ? toDay(period[1].replace(/\)$/, "")) ?? undefined : undefined,
    to: period ? toDay(period[2].replace(/\)$/, "")) ?? undefined : undefined,
    opening: null,
    closing: null,
    txns: [],
    mismatches: 0,
  };
  // Rows: items on one page at (about) the same y.
  const rows: { page: number; y: number; items: PdfItem[] }[] = [];
  const sorted = [...all].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const row = rows.find((r) => r.page === it.page && Math.abs(r.y - it.y) < 2.5);
    if (row) row.items.push(it);
    else rows.push({ page: it.page, y: it.y, items: [it] });
  }
  rows.sort((a, b) => a.page - b.page || b.y - a.y);
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);

  const header = rows.find((r) => r.items.some((i) => /^Particulars$/i.test(i.str.trim())));
  const dateX = header?.items.find((i) => /Tran\s*Date|^Date$/i.test(i.str))?.x ?? null;
  const debitX = header?.items.find((i) => /^(?:Debit|Withdrawals?)/i.test(i.str.trim()))?.x ?? null;
  const creditX = header?.items.find((i) => /^(?:Credit|Deposits?)/i.test(i.str.trim()))?.x ?? null;

  let started = !header;
  let pending: string[] = [];
  let prevBal: number | null = null;
  const pushText = (s: string) => {
    const t = s.trim();
    if (!t) return;
    pending.push(t);
  };
  for (const r of rows) {
    if (header && r === header) {
      started = true;
      continue;
    }
    if (!started) continue;
    const line = r.items.map((i) => i.str).join(" ");
    if (/OPENING BALANCE/i.test(line)) {
      const n = r.items.filter((i) => MONEY_RE.test(i.str.trim())).pop();
      if (n) out.opening = prevBal = money(n.str.trim());
      pending = [];
      continue;
    }
    if (/CLOSING BALANCE/i.test(line)) {
      const n = r.items.filter((i) => MONEY_RE.test(i.str.trim())).pop();
      if (n) out.closing = money(n.str.trim());
      break;
    }
    if (/TRANSACTION TOTAL/i.test(line)) continue;
    const first = r.items[0];
    const day = toDay(first.str);
    const isDateRow = !!day && (dateX === null || Math.abs(first.x - dateX) < 30) && r.items.some((i) => MONEY_RE.test(i.str.trim()));
    // Particulars: text between the date column and the amounts.
    const textItems = r.items.filter((i) => i !== (isDateRow ? first : null) && !MONEY_RE.test(i.str.trim()) && !(/^\d{3,5}$/.test(i.str.trim()) && i === r.items[r.items.length - 1]) && (dateX === null || i.x > dateX + 25) && (debitX === null || i.x < debitX - 10));
    for (const t of textItems) pushText(t.str);
    if (!isDateRow) continue;
    const nums = r.items.filter((i) => MONEY_RE.test(i.str.trim()));
    const balance = money(nums[nums.length - 1].str.trim());
    const amtItem = nums.length >= 2 ? nums[nums.length - 2] : null;
    let amount: number;
    if (prevBal !== null) {
      amount = Math.round((balance - prevBal) * 100) / 100;
      if (amtItem && !near(Math.abs(amount), money(amtItem.str.trim()))) out.mismatches++;
    } else if (amtItem) {
      const v = money(amtItem.str.trim());
      const isCredit = creditX !== null && debitX !== null ? Math.abs(amtItem.x - creditX) < Math.abs(amtItem.x - debitX) : false;
      amount = isCredit ? v : -v;
    } else amount = 0;
    const text = joinWrapped(pending);
    const d = describe(text);
    out.txns.push({ day: day!, order: out.txns.length, amount, balance, text, who: d.who, ...(d.ref ? { ref: d.ref } : {}) });
    prevBal = balance;
    pending = [];
  }
  if (out.opening === null && out.txns.length) out.opening = Math.round((out.txns[0].balance - out.txns[0].amount) * 100) / 100;
  if (out.closing === null && out.txns.length) out.closing = out.txns[out.txns.length - 1].balance;
  return out;
}

/** Joins the particulars lines (a space between them, none around a "/" or after a "-"). */
function joinWrapped(lines: string[]): string {
  let s = "";
  for (const l of lines) s += !s || /[/-]$/.test(s) || l.startsWith("/") ? l : ` ${l}`;
  return s.replace(/\s+/g, " ").trim();
}

const keyOf = (t: StatementTxn) => `${t.day}|${t.amount.toFixed(2)}|${t.balance.toFixed(2)}|${t.ref ?? t.text.slice(0, 24)}`;

/** Adds a statement to the saved ones; an entry already there (two statements overlapping) is kept once. */
export function mergeStatement(saved: SavedStatements | null, st: ParsedStatement, now = Date.now()): { next: SavedStatements; added: number } {
  const base: SavedStatements = saved ?? { version: 1, periods: [], txns: [] };
  const seen = new Set(base.txns.map(keyOf));
  const fresh = st.txns.filter((t) => !seen.has(keyOf(t)));
  const txns = [...base.txns, ...fresh].sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order);
  // Re-number so same-day order holds across statements.
  txns.forEach((t, i) => (t.order = i));
  return {
    next: {
      version: 1,
      account: base.account ?? st.account,
      periods: [...base.periods, { from: st.from, to: st.to, opening: st.opening, closing: st.closing, importedAt: now, count: fresh.length }],
      txns,
    },
    added: fresh.length,
  };
}

export interface DayBalance {
  day: string;
  /** Balance at the start of the day and at its end. */
  open: number;
  close: number;
  low: number;
  txns: StatementTxn[];
  in: number;
  out: number;
}

/** The statement as days, oldest first: what the balance was each day and the entries that moved it. */
export function balanceDays(saved: SavedStatements | null): DayBalance[] {
  const out: DayBalance[] = [];
  for (const t of saved?.txns ?? []) {
    let d = out[out.length - 1];
    if (!d || d.day !== t.day) {
      const open = Math.round((t.balance - t.amount) * 100) / 100;
      d = { day: t.day, open, close: open, low: open, txns: [], in: 0, out: 0 };
      out.push(d);
    }
    d.txns.push(t);
    d.close = t.balance;
    d.low = Math.min(d.low, t.balance);
    if (t.amount >= 0) d.in += t.amount;
    else d.out -= t.amount;
  }
  return out;
}

/** The balance at the end of `day` (the last entry on or before it), or null before the first. */
export function balanceOn(days: DayBalance[], day: string): number | null {
  let v: number | null = null;
  for (const d of days) {
    if (d.day > day) break;
    v = d.close;
  }
  return v;
}

/** Days (end of day) under the safety margin, and the first day it went under in the latest run. */
export function marginInfo(days: DayBalance[], margin: number): { underDays: number; since: string | null; lowest: { day: string; amount: number } | null } {
  let since: string | null = null;
  let underDays = 0;
  let lowest: { day: string; amount: number } | null = null;
  for (const d of days) {
    if (!lowest || d.low < lowest.amount) lowest = { day: d.day, amount: d.low };
    if (d.close < margin) {
      underDays++;
      since ??= d.day;
    } else since = null;
  }
  return { underDays, since, lowest };
}

export interface MarginForecast {
  level: "ok" | "near" | "under";
  balance: number;
  margin: number;
  /** Average money going out (net) per day over the recent window, ≥ 0. */
  perDay: number;
  /** Days until the balance reaches the margin at that pace (null when it isn't falling, 0 when under). */
  daysLeft: number | null;
  /** The day it's expected to reach the margin. */
  crossDay: string | null;
}

const addDaysIso = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Will the balance go near or under the safety margin? Pace = net change per day over the last
 * `window` days of history (cash deposits included, so one big deposit doesn't hide the spending
 * only if it's older than the window). "near" = within `nearBy` of the margin, or expected to cross
 * it within `soonDays`.
 */
export function forecastMargin(days: DayBalance[], balance: number, margin: number, today: string, opts: { window?: number; soonDays?: number; nearBy?: number } = {}): MarginForecast {
  const window = opts.window ?? 45;
  const soonDays = opts.soonDays ?? 14;
  const nearBy = opts.nearBy ?? Math.max(1000, margin * 0.1);
  const from = addDaysIso(today, -window);
  const recent = days.filter((d) => d.day > from);
  let perDay = 0;
  if (recent.length) {
    const span = Math.max(14, Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${recent[0].day}T12:00:00`)) / 86_400_000) + 1);
    const net = recent.reduce((s, d) => s + d.in - d.out, 0);
    perDay = Math.max(0, -net / span);
  }
  const gap = balance - margin;
  const daysLeft = gap <= 0 ? 0 : perDay > 0 ? Math.floor(gap / perDay) : null;
  const level = gap < 0 ? "under" : gap <= nearBy || (daysLeft !== null && daysLeft <= soonDays) ? "near" : "ok";
  return { level, balance, margin, perDay: Math.round(perDay * 100) / 100, daysLeft, crossDay: daysLeft !== null ? addDaysIso(today, daysLeft) : null };
}

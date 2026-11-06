import type { JSONContent } from "@tiptap/react";
import { formatTimestamp, TIMESTAMP_RE } from "./timestamp";

/**
 * Money in and out. Bank SMS alerts and payment-app notifications (read on the phone) become one
 * line each in that day's note, inside a [[Finance]] box:
 *   "4,November,2026 Wednesday (13:02:11) 💸 ₹250.00 to Swiggy #food (HDFC ••1234 · UPI · ref 430912345678)"
 *   "… 💰 ₹5,000.00 from Ravi Patel #income (SBI ••5678 · NEFT)"
 * So they sync and merge like any writing, and a line typed by hand ("💸 ₹40 to chai #food") counts
 * the same. Changing "#food" to "#travel" in the note re-files it. The dashboard is worked out from
 * the lines and never written back.
 */

export type Direction = "debit" | "credit";

export interface Txn {
  direction: Direction;
  amount: number;
  /** Who was paid or who paid. */
  party?: string;
  category: string;
  bank?: string;
  /** Last digits of the account or card. */
  account?: string;
  method?: string;
  ref?: string;
  /** Balance after it, when the bank says. */
  balance?: number;
  /** When it happened (ms). */
  at: number;
  /** Where it was read from. */
  source?: "sms" | "notification" | "note";
  /** Read from a note: the line as written there, and that note's day (to edit it). */
  line?: string;
  day?: string;
}

/** The category of a payment marked "not a payment": kept in the note (so it isn't brought in again), left out of the money views. */
export const IGNORED = "ignored";

export const FINANCE_BOX = "[[Finance]]";

const AMOUNT = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)/i;
const DEBIT_WORDS = /\b(debited|spent|sent|paid|withdrawn|purchase|dr\b|transferred to|deducted)/i;
const CREDIT_WORDS = /\b(credited|received|deposited|refund(?:ed)?|paid you|sent you|cr\b|added to)/i;
/** Not a transaction: codes, offers, requests, reminders, failures, future debits. */
const NOT_TXN = /\b(otp|one[- ]time password|verification code|offer|cashback up to|pre-?approved|loan of up to|win\b|requested|request(?:ing)? (?:money|payment)|collect request|is due|due (?:on|by|date)|minimum (?:amount )?due|will be debited|to be debited|scheduled|failed|declined|unsuccessful|could not be|reversal initiated|e-?mandate|autopay (?:set|registered)|statement)/i;

const BANKS: [RegExp, string][] = [
  [/hdfc/i, "HDFC"], [/icici/i, "ICICI"], [/\bsbi\b|sbiinb|sbiupi|state bank/i, "SBI"], [/axis/i, "Axis"], [/kotak|kmbl/i, "Kotak"],
  [/\bpnb\b|punjab national/i, "PNB"], [/bank of baroda|\bbob\b/i, "BoB"], [/canara/i, "Canara"], [/union bank|unionb/i, "Union"],
  [/idfc/i, "IDFC"], [/yes ?bank|yesbnk/i, "Yes"], [/indusind/i, "IndusInd"], [/federal/i, "Federal"], [/\bau bank|aubank/i, "AU"],
  [/paytm/i, "Paytm"], [/airtel/i, "Airtel"], [/rbl/i, "RBL"], [/bank of india|\bboi\b/i, "BoI"], [/central bank/i, "Central"],
];

const APPS: Record<string, string> = {
  "com.google.android.apps.nbu.paisa.user": "Google Pay",
  "com.phonepe.app": "PhonePe",
  "net.one97.paytm": "Paytm",
  "in.org.npci.upiapp": "BHIM",
  "com.dreamplug.androidapp": "CRED",
  "com.amazon.mShop.android.shopping": "Amazon Pay",
};

/** Spending groups, by words in who was paid. First match wins. */
const CATEGORIES: [string, RegExp][] = [
  ["food", /swiggy|zomato|restaurant|cafe|caf[eé]|dominos|domino|mcdonald|kfc|pizza|burger|bakery|sweets|dhaba|food|eatery|chai|tea\b|starbucks|haldiram|biryani/i],
  ["groceries", /bigbasket|blinkit|zepto|instamart|dmart|d-mart|jiomart|grocery|grocer|kirana|supermarket|reliance fresh|more retail|milk|dairy|amul/i],
  ["travel", /uber|\bola\b|rapido|irctc|railway|redbus|makemytrip|goibibo|indigo|air ?india|vistara|akasa|metro|fastag|toll|parking|cab\b|auto\b/i],
  ["fuel", /petrol|fuel|diesel|\bhpcl\b|\bbpcl\b|indian ?oil|\biocl\b|bharat petroleum|hindustan petroleum|shell|nayara|\bcng\b/i],
  ["shopping", /amazon|flipkart|myntra|ajio|meesho|nykaa|tata ?cliq|croma|reliance digital|decathlon|ikea|lenskart|snapdeal|mall\b|store\b/i],
  ["bills", /electricity|pgvcl|torrent power|ugvcl|mgvcl|dgvcl|power\b|water\b|gas\b|gujarat gas|airtel|jio|vodafone|\bvi\b|bsnl|recharge|broadband|dth|tata ?play|bill ?desk|billdesk|postpaid|insurance|lic\b|premium/i],
  ["health", /pharmacy|medical|chemist|apollo|hospital|clinic|doctor|1mg|pharmeasy|netmeds|diagnostic|lab\b|dental|gym|cult\.?fit/i],
  ["fun", /netflix|spotify|prime video|hotstar|jiocinema|bookmyshow|youtube|pvr|inox|cinema|steam|playstation|xbox|game/i],
  ["education", /college|university|school|udemy|coursera|unacademy|byju|fees?\b|tuition|book/i],
  ["rent", /\brent\b|landlord|society|maintenance|housing/i],
  ["cash", /\batm\b|cash withdrawal|withdrawn at|cash wdl/i],
  ["investments", /zerodha|groww|upstox|mutual fund|\bsip\b|\bnps\b|\bppf\b|smallcase|kuvera|coin by zerodha|angel ?one/i],
];

export const CATEGORY_ICONS: Record<string, string> = {
  food: "🍽️", groceries: "🛒", travel: "🚕", fuel: "⛽", shopping: "🛍️", bills: "🧾", health: "🩺", fun: "🎬", education: "📚",
  rent: "🏠", cash: "🏧", investments: "📈", transfer: "🔁", income: "💰", refund: "↩️", other: "💸",
};

const num = (s: string) => Number(s.replace(/,/g, ""));
const clean = (s: string) =>
  s
    .replace(/[#()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.,;:\-\s]+$/, "")
    .trim()
    .slice(0, 48);

/** The spending group for a payee (credits are "income"; people and UPI ids are "transfer"). */
export function categorize(party: string | undefined, direction: Direction, text = ""): string {
  if (direction === "credit") return /refund|cashback|reversal/i.test(text) ? "refund" : "income";
  const hay = `${party ?? ""} ${text}`;
  for (const [cat, re] of CATEGORIES) if (re.test(party ?? "") || (cat === "cash" && re.test(hay))) return cat;
  // A UPI id or a person's name: money sent to someone.
  if (party && (/@/.test(party) || /^[A-Za-z]+(?: [A-Za-z]+){0,3}$/.test(party))) return "transfer";
  return "other";
}

/** Who the money went to or came from, from the usual Indian bank alert wordings. */
function partyOf(text: string, direction: Direction): string | undefined {
  const pats =
    direction === "debit"
      ? [
          /\bto VPA\s+([\w.\-@]+)/i,
          /;\s*([^;]+?)\s+credited/i,
          /\b(?:trf|transfer(?:red)?|paid|sent)\s+to\s+([A-Za-z0-9 .&'@_\-*]+?)(?=\s+(?:on|ref|via|upi|from|using|\.|$)|[.;,(]|$)/i,
          /\bto\s+([A-Za-z0-9 .&'@_\-*]+?)(?=\s+(?:on|ref|via|upi)\b|[.;,(]|$)/i,
          /\b(?:at|@)\s+([A-Za-z0-9 .&'_\-*]+?)(?=\s+(?:on|ref|via|txn|avl)\b|[.;,(]|$)/i,
          /\binfo:?\s*([A-Za-z0-9 .&'@_\-*/]+?)(?=[.;,(]|\s+avl|$)/i,
          // "spent using … Card XX9876 on 04-Nov-26 on BIGBASKET."
          /\bon\s+(?!date\b)([A-Za-z][A-Za-z0-9 .&'_\-*]+?)(?=[.;,(]|\s+avl|$)/i,
        ]
      : [
          /\bfrom VPA\s+([\w.\-@]+)/i,
          /\bby\s+(?:a\/c linked to\s+)?VPA\s+([\w.\-@]+)/i,
          /^\s*([A-Za-z][A-Za-z .]+?)\s+(?:has\s+)?(?:paid|sent) you/i,
          /\b(?:received|credited)[^.;]*?\bfrom\s+([A-Za-z0-9 .&'@_\-*]+?)(?=\s+(?:on|ref|via|upi|to)\b|[.;,(]|$)/i,
          /\bby\s+([A-Za-z][A-Za-z0-9 .&'@_\-]+?)(?=\s+(?:on|ref|via|upi)\b|[.;,(]|$)/i,
        ];
  for (const re of pats) {
    const m = re.exec(text);
    if (!m) continue;
    const p = clean(m[1]);
    if (p && !/^(a\/c|ac|account|your|you|rs|inr|xx|\*+|\d+)$/i.test(p) && !/^(a\/c|acct|account)\b/i.test(p)) return p;
  }
  return undefined;
}

/**
 * A bank SMS or payment notification → a transaction, or null when it isn't one (an OTP, an offer,
 * a request, a due-date reminder, a failed payment…).
 */
export function parseMessage(text: string, at: number, from = "", source: Txn["source"] = "sms"): Txn | null {
  const body = text.replace(/\s+/g, " ").trim();
  if (!body || NOT_TXN.test(body)) return null;
  const debit = DEBIT_WORDS.exec(body);
  const credit = CREDIT_WORDS.exec(body);
  if (!debit && !credit) return null;
  // The word that comes first decides ("debited … ; SWIGGY credited" is money out).
  const direction: Direction = debit && (!credit || debit.index < credit.index) ? "debit" : "credit";
  let amount: number | null = null;
  const m = AMOUNT.exec(body);
  if (m) amount = num(m[1]);
  else {
    // "debited by 250.0" (SBI writes no currency).
    const bare = /\b(?:debited|credited)\s+(?:by|with|for)\s+([\d,]+(?:\.\d{1,2})?)/i.exec(body);
    if (bare) amount = num(bare[1]);
  }
  if (!amount || !Number.isFinite(amount) || amount <= 0) return null;
  const bankHit = BANKS.find(([re]) => re.test(`${from} ${body}`));
  const app = APPS[from];
  const account = /(?:a\/c|acct|account|card|a\/c no\.?)\s*(?:no\.?\s*)?(?:ending\s*(?:with)?\s*)?[x*•.]*\s*(\d{3,6})\b/i.exec(body)?.[1];
  const method = /\bupi\b|vpa|@ok|@ybl|@paytm|@ibl|@axl/i.test(body) || app ? "UPI" : /\bneft\b/i.test(body) ? "NEFT" : /\bimps\b/i.test(body) ? "IMPS" : /\brtgs\b/i.test(body) ? "RTGS" : /\batm\b/i.test(body) ? "ATM" : /\bcard\b/i.test(body) ? "Card" : undefined;
  const ref = /(?:ref(?:erence)?\.?\s*(?:no\.?|number|id)?|upi(?:\s*ref)?|txn\s*(?:id|no)?|rrn)\s*[:#-]?\s*(\d{8,})/i.exec(body)?.[1];
  const bal = /(?:avl\.?\s*bal(?:ance)?|available balance|a\/c bal(?:ance)?|bal(?:ance)?)\s*(?:is|:)?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(body)?.[1];
  const party = partyOf(body, direction);
  return {
    direction,
    amount,
    ...(party ? { party } : {}),
    category: categorize(party, direction, body),
    ...(bankHit ? { bank: bankHit[1] } : app ? { bank: app } : {}),
    ...(account ? { account } : {}),
    ...(method ? { method } : {}),
    ...(ref ? { ref } : {}),
    ...(bal ? { balance: num(bal) } : {}),
    at,
    source,
  };
}

/** "₹1,23,456.50" (Indian grouping). */
export function rupees(n: number, decimals = 2): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** The line written into the note for a transaction. */
export function txnLine(t: Txn): string {
  const icon = t.direction === "debit" ? "💸" : "💰";
  const who = t.party ? ` ${t.direction === "debit" ? "to" : "from"} ${clean(t.party)}` : "";
  const extra = [t.bank && t.account ? `${t.bank} ••${t.account}` : t.bank ?? (t.account ? `••${t.account}` : ""), t.method ?? "", t.ref ? `ref ${t.ref}` : "", t.balance !== undefined ? `bal ${rupees(t.balance)}` : ""].filter(Boolean);
  return `${formatTimestamp(new Date(t.at))} ${icon} ${rupees(t.amount)}${who} #${t.category}${extra.length ? ` (${extra.join(" · ")})` : ""}`;
}

const LINE = /(💸|💰)\s*(?:₹|rs\.?\s*|inr\s*)([\d,]+(?:\.\d+)?)(.*)$/iu;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A note line → a transaction (written by the app or by hand), or null. `day` is used when the line has no timestamp. */
export function readLine(line: string, day: string): Txn | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const amount = num(m[2]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const direction: Direction = m[1] === "💰" ? "credit" : "debit";
  let rest = m[3];
  const tag = /#([\p{L}\p{N}_-]+)/u.exec(rest);
  const paren = /\(([^()]*)\)\s*$/.exec(rest);
  if (paren) rest = rest.slice(0, paren.index);
  const party = /^\s*(?:to|from|at)\s+([^#]+?)\s*(?:#|$)/i.exec(rest)?.[1];
  const ts = new RegExp(TIMESTAMP_RE.source).exec(line);
  let at: number;
  if (ts) at = new Date(Number(ts[3]), MONTHS.indexOf(ts[2]), Number(ts[1]), Number(ts[5]), Number(ts[6]), Number(ts[7])).getTime();
  else {
    const [y, mo, d] = day.split("-").map(Number);
    at = new Date(y, mo - 1, d, 12).getTime();
  }
  const info = paren?.[1] ?? "";
  const ref = /ref\s+(\d{6,})/i.exec(info)?.[1];
  const acct = /([A-Za-z][\w ]*?)\s*••(\d{3,6})/.exec(info);
  return {
    direction,
    amount,
    ...(party ? { party: party.trim() } : {}),
    category: (tag?.[1] ?? (direction === "credit" ? "income" : "other")).toLowerCase(),
    ...(acct ? { bank: acct[1].trim(), account: acct[2] } : {}),
    ...(ref ? { ref } : {}),
    at,
    source: "note",
    line,
    day,
  };
}

export interface TxnPatch {
  amount?: number;
  direction?: Direction;
  party?: string;
  category?: string;
  /** "HH:MM" on the same day. */
  time?: string;
}

/**
 * A note's payment line with some of it corrected (amount, in/out, who, category, time). What
 * else is on the line (the timestamp's date, the bank details in brackets) stays as it was.
 */
export function rewriteLine(line: string, day: string, patch: TxnPatch): string | null {
  const t = readLine(line, day);
  const m = LINE.exec(line);
  if (!t || !m) return null;
  let head = line.slice(0, m.index);
  const paren = /\(([^()]*)\)\s*$/.exec(m[3]);
  if (patch.time && /^\d{1,2}:\d{2}$/.test(patch.time)) {
    const [hh, mm] = patch.time.split(":").map(Number);
    const ts = new RegExp(TIMESTAMP_RE.source).exec(head);
    const d = new Date(t.at);
    d.setHours(hh, mm, ts ? d.getSeconds() : 0, 0);
    head = ts ? head.replace(ts[0], formatTimestamp(d)) : `${formatTimestamp(d)} ${head}`;
  }
  if (head && !/\s$/.test(head)) head += " ";
  const direction = patch.direction ?? t.direction;
  const amount = patch.amount !== undefined && Number.isFinite(patch.amount) && patch.amount > 0 ? patch.amount : t.amount;
  const party = clean((patch.party ?? t.party ?? "").replace(/[#()]/g, " ")).trim();
  const category = (patch.category ?? t.category).trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || (direction === "credit" ? "income" : "other");
  const who = party ? ` ${direction === "debit" ? "to" : "from"} ${party}` : "";
  return `${head}${direction === "debit" ? "💸" : "💰"} ${rupees(amount)}${who} #${category}${paren ? ` (${paren[1]})` : ""}`;
}

/** Every transaction line in a day's note. */
export function txnsIn(doc: JSONContent | null | undefined, day: string): Txn[] {
  const out: Txn[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "codeBlock") return;
    if (n.type === "paragraph" || n.type === "heading") {
      const t = readLine((n.content ?? []).map((c) => c.text ?? "").join(""), day);
      if (t) out.push(t);
      return;
    }
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return out;
}

/**
 * Already in the notes? The same bank reference, or (when one side has no reference, like a
 * Google Pay notification and the bank's SMS for the same payment) the same amount and direction
 * within 15 minutes.
 */
export function alreadyHave(t: Txn, have: Txn[]): boolean {
  return have.some((h) => {
    if (h.direction !== t.direction || Math.abs(h.amount - t.amount) > 0.005) return false;
    if (t.ref && h.ref) return t.ref === h.ref;
    return Math.abs(h.at - t.at) <= 15 * 60_000;
  });
}

// ───── The dashboard ─────

export interface MonthSummary {
  month: string; // YYYY-MM
  spent: number;
  received: number;
  byCategory: Map<string, number>;
}

const monthOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Money moved between your own accounts or into savings isn't spending. */
export const notSpending = (cat: string) => cat === "investments" || cat === "self";

export function monthly(txns: Txn[]): MonthSummary[] {
  const by = new Map<string, MonthSummary>();
  for (const t of txns) {
    const k = monthOf(t.at);
    let s = by.get(k);
    if (!s) by.set(k, (s = { month: k, spent: 0, received: 0, byCategory: new Map() }));
    if (t.direction === "credit") s.received += t.amount;
    else {
      if (!notSpending(t.category)) s.spent += t.amount;
      s.byCategory.set(t.category, (s.byCategory.get(t.category) ?? 0) + t.amount);
    }
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Spending per day for the last `days` days ending `today` (YYYY-MM-DD), oldest first. */
export function dailySpend(txns: Txn[], today: Date, days: number): { day: Date; spent: number }[] {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const out = Array.from({ length: days }, (_, i) => ({ day: new Date(end - (days - 1 - i) * 86_400_000), spent: 0 }));
  for (const t of txns) {
    if (t.direction !== "debit" || notSpending(t.category)) continue;
    const d = new Date(t.at);
    const i = days - 1 - Math.round((end - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
    if (i >= 0 && i < days) out[i].spent += t.amount;
  }
  return out;
}

/**
 * Where this month is heading: spent so far + the usual daily spend (the median of the last 60
 * days, so one big purchase doesn't skew it) for the days left. Null with too little history.
 */
export function forecastMonth(txns: Txn[], now: Date): { soFar: number; projected: number; perDay: number } | null {
  const history = dailySpend(txns, now, 60);
  const active = history.filter((d) => d.spent > 0).length;
  if (active < 5) return null;
  const sorted = history.map((d) => d.spent).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  // Between the median and the mean: everyday spending plus a share of the occasional big one.
  const perDay = (median + mean) / 2;
  const month = monthOf(now.getTime());
  const soFar = txns.filter((t) => t.direction === "debit" && !notSpending(t.category) && monthOf(t.at) === month).reduce((a, t) => a + t.amount, 0);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const left = daysInMonth - now.getDate();
  return { soFar, projected: soFar + perDay * left, perDay };
}

/** The biggest payees in a set of transactions. */
export function topPayees(txns: Txn[], n = 5): { party: string; total: number; count: number }[] {
  const by = new Map<string, { party: string; total: number; count: number }>();
  for (const t of txns) {
    if (t.direction !== "debit" || !t.party) continue;
    const k = t.party.toLowerCase();
    const e = by.get(k) ?? { party: t.party, total: 0, count: 0 };
    e.total += t.amount;
    e.count++;
    by.set(k, e);
  }
  return [...by.values()].sort((a, b) => b.total - a.total).slice(0, n);
}

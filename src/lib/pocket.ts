import type { JSONContent } from "@tiptap/react";
import { categorize, type Txn } from "./finance";
import { dayKey, TIMESTAMP_RE } from "./timestamp";

/**
 * 👛 Pocket: the cash in Hapi's physical wallet, the way the bank SMS lines are the online account.
 * Written the way Hapi already writes it: lines nested under a [[pocket]] line in a day's note,
 *   [[pocket]]
 *     Hair cut and beard: 350
 *     Brought 2 masala dosas (one cheese added), total 400-30 = 370
 *     Added from ATM: +2000
 *     Counted: 1240
 * Each line is "what: amount" (the last "= n" wins, so a sum can be written out). "+", "added",
 * "got", "received", "withdrew" mean cash came in; "counted", "left", "in pocket now" set the
 * balance to what was counted. Anything else is cash spent. A line that carries [[pocket]]
 * itself ("chai 20 [[pocket]]") counts too.
 */

export const POCKET_BOX = "[[pocket]]";
export const POCKET = "Pocket";

export type PocketKind = "out" | "in" | "count";

export interface PocketEntry {
  kind: PocketKind;
  amount: number;
  what: string;
  category: string;
  day: string;
  /** When (ms): the line's timestamp, else the day at noon plus its place in the box. */
  at: number;
  line: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Only at the start of the line (or a "+" before the amount): "one cheese added" is still a spend.
const IN_WORDS = /(?:^|[:\s])\+\s*(?:₹|rs\.?\s*)?\d|^\s*(?:[-*•]\s*)?(?:added|add|got|received|withdrew|withdrawn|withdrawal|atm|from atm|top[- ]?up|topped up|refund(?:ed)?|cash in)\b/i;
const COUNT_WORDS = /^\s*(?:[-*•]\s*)?(?:count(?:ed)?|left in (?:my )?(?:pocket|wallet)|in (?:my )?(?:pocket|wallet) now|wallet has|pocket has|balance)\b/i;
const NUMBER = /(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:rs|rupees?|₹|\/-)?/gi;

const isPocketTitle = (text: string) => /\[\[\s*pocket\s*(?:\|[^\]]*)?\]\]/i.test(text);

/** The amount on a pocket line: after the last "=", else after ":", else the last number. */
export function pocketAmount(text: string): number | null {
  const clean = text.replace(new RegExp(TIMESTAMP_RE.source, "g"), " ").replace(/\[\[[^\]]*\]\]/g, " ");
  const eq = clean.lastIndexOf("=");
  const colon = clean.lastIndexOf(":");
  const tail = eq >= 0 ? clean.slice(eq + 1) : colon >= 0 ? clean.slice(colon + 1) : clean;
  const nums = [...tail.matchAll(NUMBER)].map((m) => Number(m[1].replace(/,/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length) return eq >= 0 || colon >= 0 ? nums[0] : nums[nums.length - 1];
  return null;
}

/** "Hair cut and beard: 350" → "Hair cut and beard". */
export function pocketWhat(text: string): string {
  let t = text.replace(new RegExp(TIMESTAMP_RE.source, "g"), " ").replace(/\[\[[^\]]*\]\]/g, " ").replace(/^\s*[-*•]\s*/, "");
  const eq = t.lastIndexOf("=");
  const colon = t.lastIndexOf(":");
  if (eq > 0) t = t.slice(0, eq).replace(/[\d\s+\-*/x×.,]+$/i, "").replace(/[,\s]*\btotal\b\s*$/i, "");
  else if (colon > 0) t = t.slice(0, colon);
  else t = t.replace(NUMBER, " ");
  return t.replace(/\s+/g, " ").replace(/[,.;:\-\s]+$/, "").trim().slice(0, 80);
}

/** One line of the box → an entry, or null when it has no amount. */
export function readPocketLine(line: string, day: string, order = 0): PocketEntry | null {
  const amount = pocketAmount(line);
  if (amount === null) return null;
  const what = pocketWhat(line) || "Cash";
  const kind: PocketKind = COUNT_WORDS.test(line) ? "count" : IN_WORDS.test(line) ? "in" : "out";
  const ts = new RegExp(TIMESTAMP_RE.source).exec(line);
  let at: number;
  if (ts) at = new Date(Number(ts[3]), MONTHS.indexOf(ts[2]), Number(ts[1]), Number(ts[5]), Number(ts[6]), Number(ts[7])).getTime();
  else {
    const [y, mo, d] = day.split("-").map(Number);
    at = new Date(y, mo - 1, d, 12).getTime() + order;
  }
  const category = kind === "out" ? spendCategory(what) : kind === "in" ? "cash" : "count";
  return { kind, amount, what, category, day, at, line };
}

/** The spending group for something bought with cash. */
export function spendCategory(what: string): string {
  if (/hair ?cut|barber|salon|beard|shave|parlou?r|spa\b|massage/i.test(what)) return "personal";
  if (/dosa|dosha|chai|tea\b|coffee|lunch|dinner|breakfast|snack|pani ?puri|vada|samosa|sandwich|juice|ice ?cream|thali|food|meal|biryani|pizza|burger/i.test(what)) return "food";
  if (/auto|rickshaw|bus\b|cab\b|taxi|train|ticket|parking|toll/i.test(what)) return "travel";
  if (/vegetable|sabzi|sabji|fruit|milk|grocer|kirana/i.test(what)) return "groceries";
  if (/tip\b|donat|temple|gift/i.test(what)) return "gifts";
  const cat = categorize(what, "debit");
  return cat === "transfer" || cat === "other" ? "other" : cat;
}

/** Every pocket entry in a day's note, in the order written. */
export function pocketIn(doc: JSONContent | null | undefined, day: string): PocketEntry[] {
  const out: PocketEntry[] = [];
  const blocks = doc?.content ?? [];
  const textOf = (b: JSONContent): string => (b.text ?? "") + (b.content ?? []).map(textOf).join("");
  const push = (text: string) => {
    const e = readPocketLine(text, day, out.length);
    if (e) out.push(e);
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "codeBlock") continue;
    const text = textOf(b);
    if (!isPocketTitle(text)) continue;
    // "chai 20 [[pocket]]": the line itself.
    if (pocketAmount(text) !== null) push(text);
    // A list under it (bullets) or nested lines under it (indent).
    const level = Number(b.attrs?.indent ?? 0);
    let j = i + 1;
    for (; j < blocks.length && Number(blocks[j].attrs?.indent ?? 0) > level; j++) {
      if (blocks[j].type === "paragraph") push(textOf(blocks[j]));
      else if (/List$/.test(blocks[j].type ?? "")) for (const item of blocks[j].content ?? []) push(textOf(item));
    }
    // A bullet list right under the title line.
    if (j === i + 1 && /List$/.test(blocks[j]?.type ?? "")) for (const item of blocks[j].content ?? []) push(textOf(item));
    i = j - 1;
  }
  return out;
}

/** The page called "pocket" itself: each line of it with an amount is an entry (the list Hapi keeps there). */
export function pocketPageEntries(doc: JSONContent | null | undefined, day: string): PocketEntry[] {
  const out: PocketEntry[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "codeBlock") return;
    if (n.type === "paragraph" || n.type === "heading") {
      const text = (n.content ?? []).map((c) => c.text ?? "").join("");
      const e = readPocketLine(text, day, out.length);
      if (e) out.push(e);
      return;
    }
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return out;
}

export interface PocketState {
  /** Cash in the wallet now, when it was counted at least once (else null). */
  balance: number | null;
  /** The last count. */
  counted: PocketEntry | null;
  /** Cash in minus cash out since the last count (or since the first entry). */
  change: number;
  spentMonth: number;
  spentToday: number;
  byCategory: Map<string, number>;
  entries: PocketEntry[];
}

/** Bank withdrawals at an ATM put cash in the pocket (the bank line is the money moving, not spending). */
export function atmTopUps(txns: Txn[]): PocketEntry[] {
  return txns
    .filter((t) => t.direction === "debit" && t.category === "cash" && t.bank !== POCKET)
    .map((t) => ({ kind: "in" as const, amount: t.amount, what: `ATM ${t.bank ?? ""}`.trim(), category: "cash", day: dayKey(new Date(t.at)), at: t.at, line: t.line ?? "" }));
}

export function pocketState(entries: PocketEntry[], now = new Date()): PocketState {
  const list = [...entries].sort((a, b) => a.at - b.at);
  let counted: PocketEntry | null = null;
  for (const e of list) if (e.kind === "count") counted = e;
  let change = 0;
  for (const e of list) {
    if (counted && e.at <= counted.at) continue;
    if (e.kind === "in") change += e.amount;
    if (e.kind === "out") change -= e.amount;
  }
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const today = `${month}-${String(now.getDate()).padStart(2, "0")}`;
  const byCategory = new Map<string, number>();
  let spentMonth = 0;
  let spentToday = 0;
  for (const e of list) {
    if (e.kind !== "out" || !e.day.startsWith(month)) continue;
    spentMonth += e.amount;
    if (e.day === today) spentToday += e.amount;
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
  }
  return { balance: counted ? counted.amount + change : null, counted, change, spentMonth, spentToday, byCategory, entries: list };
}

/** Pocket entries as transactions, so the money views count cash too. */
export function pocketTxns(entries: PocketEntry[]): Txn[] {
  return entries
    .filter((e) => e.kind !== "count" && !/^ATM\b/.test(e.what))
    .map((e) => ({ direction: e.kind === "in" ? "credit" : "debit", amount: e.amount, party: e.what, category: e.kind === "in" ? "cash" : e.category, bank: POCKET, method: "cash", at: e.at, source: "note", line: e.line, day: e.day }) satisfies Txn);
}

/** The line written for a cash spend / cash in / count. */
export function pocketLine(kind: PocketKind, amount: number, what: string): string {
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const w = what.replace(/[:\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (kind === "count") return `Counted pocket: ${n}`;
  if (kind === "in") return `${w || "Added"}: +${n}`;
  return `${w || "Spent"}: ${n}`;
}

/**
 * A sentence about spending cash → the entry to add, or null. "I had a haircut costing 350 rupees
 * from my pocket", "spent 370 on food from pocket", "paid 40 cash for chai", "took 2000 from ATM".
 */
export function pocketFromSentence(text: string): { kind: PocketKind; amount: number; what: string } | null {
  const t = text.trim();
  if (!/\b(pocket|wallet|cash|atm)\b/i.test(t)) return null;
  const m = /(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:₹|rs\b|rupees?|bucks|\/-)|\b(?:cost(?:ing|s)?|spent|paid|for|of|took|withdrew|got|added|counted|have|has)\s+(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\b/i.exec(t);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
  if (!raw) return null;
  const amount = Number(raw.replace(/,/g, ""));
  if (!(amount > 0)) return null;
  const kind: PocketKind = /\b(count(?:ed)?|left in|have .* in (?:my )?(?:pocket|wallet)|wallet has|pocket has)\b/i.test(t)
    ? "count"
    : /\b(took|withdrew|withdrawn|atm|got|received|added|put .* in(?:to)? (?:my )?(?:pocket|wallet)|gave me)\b/i.test(t) && !/\b(spent|paid|bought|cost)/i.test(t)
      ? "in"
      : "out";
  let what = t
    .replace(/^(?:i\s+)?(?:just\s+)?(?:had|have|did|got|bought|brought|paid for|spent on|spent)\s+(?:a|an|the|my|some)?\s*/i, "")
    .replace(/\b(?:it\s+)?(?:cost(?:ing|s)?|for|of|worth|total)\b.*$/i, "")
    .replace(/(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:₹|rs|rupees?|bucks|\/-)?/gi, " ")
    .replace(/\b(?:from|out of|in|into|with)\s+(?:my\s+)?(?:pocket|wallet|cash)\b.*$/i, "")
    .replace(/\b(?:just|done|and|which|that|it)\b\s*$/i, "")
    .replace(/[.,;!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (kind === "in") what = /atm/i.test(t) ? "From ATM" : what || "Added";
  if (kind === "count") what = "Counted";
  if (what) what = what[0].toUpperCase() + what.slice(1);
  return { kind, amount, what: what || "Spent" };
}

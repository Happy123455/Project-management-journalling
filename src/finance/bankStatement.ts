import type { JournalStore } from "../store";
import { openPdf } from "../editor/pdf";
import { mergeStatement, parseStatement, type ParsedStatement, type PdfItem, type SavedStatements } from "../lib/bankStatement";
import { FINANCE_EVENT } from "./capture";
import { loadBank } from "./bank";

/** 🏦 Imported bank statements (src/lib/bankStatement.ts), kept as one file in the app's own data (and its sync folder). */
export const STATEMENT_FILE = "bank-statement.json";
const MARGIN_KEY = "journal.bankMargin";
export const DEFAULT_MARGIN = 15000;

export function readMargin(): number {
  try {
    const v = Number(localStorage.getItem(MARGIN_KEY));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MARGIN;
  } catch {
    return DEFAULT_MARGIN;
  }
}
export function saveMargin(n: number) {
  try {
    localStorage.setItem(MARGIN_KEY, String(n));
  } catch {
    /* private window: keeps the default */
  }
}

export async function loadStatements(store: JournalStore): Promise<SavedStatements | null> {
  const rec = await store.findFile(STATEMENT_FILE);
  if (!rec) return null;
  const bytes = await store.fileBytes(rec.id);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as SavedStatements;
    return v && Array.isArray(v.txns) ? v : null;
  } catch {
    return null;
  }
}

/** The statement's text items, page by page. Throws pdf.js's PasswordException for a locked PDF. */
export async function pdfItems(bytes: Uint8Array, password?: string): Promise<PdfItem[]> {
  const doc = await openPdf(bytes, password);
  const out: PdfItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    for (const it of tc.items) if ("str" in it && it.str.trim()) out.push({ page: p, x: it.transform[4], y: it.transform[5], str: it.str });
  }
  void doc.cleanup?.();
  return out;
}

export const isPasswordError = (e: unknown) => (e as { name?: string })?.name === "PasswordException";

/** Reads a statement PDF and adds its entries to the saved ones. */
export async function importStatement(store: JournalStore, bytes: Uint8Array, password?: string): Promise<{ saved: SavedStatements; parsed: ParsedStatement; added: number }> {
  const parsed = parseStatement(await pdfItems(bytes, password));
  if (!parsed.txns.length) throw new Error("No entries found in that PDF. Is it the bank's account statement?");
  const { next, added } = mergeStatement(await loadStatements(store), parsed);
  await store.saveFile({ name: STATEMENT_FILE, mime: "application/json", bytes: new TextEncoder().encode(JSON.stringify(next)) });
  window.dispatchEvent(new CustomEvent(FINANCE_EVENT, { detail: { bank: true } }));
  return { saved: next, parsed, added };
}

/** What the bank holds now: the newest of the statement's last balance and a typed "Bank" balance. */
export async function bankNow(store: JournalStore): Promise<{ saved: SavedStatements | null; balance: number | null; at: number }> {
  const saved = await loadStatements(store);
  const t = saved?.txns[saved.txns.length - 1];
  let balance: number | null = null;
  let at = 0;
  if (t) {
    const [y, mo, d] = t.day.split("-").map(Number);
    balance = t.balance;
    at = new Date(y, mo - 1, d, 23, 59).getTime();
  }
  try {
    const typed = (await loadBank(store)).filter((e) => /^bank$/i.test(e.account));
    const last = typed[typed.length - 1];
    if (last && last.at > at) (balance = last.amount), (at = last.at);
  } catch {
    /* typed balances are optional */
  }
  return { saved, balance, at };
}

import { useEffect, useMemo, useState } from "react";
import type { JournalStore } from "../store";
import { rupees } from "../lib/finance";
import { bankState, type BankEntry } from "../lib/bank";
import { pocketState, type PocketEntry } from "../lib/pocket";
import { showError, showToast } from "../lib/toast";
import { addBank, loadBank } from "./bank";
import { loadPocket } from "./pocket";
import { FINANCE_EVENT } from "./capture";

const r0 = (n: number) => rupees(n, 0);
const when = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });

/** The total over time as a small line (no animation, drawn once). */
function Trend({ points }: { points: { at: number; total: number }[] }) {
  if (points.length < 2) return null;
  const w = 300;
  const h = 64;
  const t0 = points[0].at;
  const t1 = points[points.length - 1].at || t0 + 1;
  const lo = Math.min(...points.map((p) => p.total));
  const hi = Math.max(...points.map((p) => p.total));
  const x = (at: number) => ((at - t0) / Math.max(1, t1 - t0)) * (w - 8) + 4;
  const y = (v: number) => h - 6 - ((v - lo) / Math.max(1, hi - lo)) * (h - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.total).toFixed(1)}`).join(" ");
  return (
    <svg className="bank-trend" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Bank total from ${r0(points[0].total)} to ${r0(points[points.length - 1].total)}`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points[points.length - 1].at)} cy={y(points[points.length - 1].total)} r="3.5" fill="currentColor" />
    </svg>
  );
}

/**
 * 🏦 Bank (Hapi, 18 Nov): type the balance the bank app shows whenever you check it; each one is
 * kept, so this shows the history and how it moved. Separate from 👛 Pocket (cash in the wallet).
 */
export function BankTab({ store, onOpenDay }: { store: JournalStore; onOpenDay: (day: string) => void }) {
  const [entries, setEntries] = useState<BankEntry[] | null>(null);
  const [cash, setCash] = useState<PocketEntry[]>([]);
  const [account, setAccount] = useState("Bank");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => {
      void loadBank(store).then(setEntries).catch(() => setEntries([]));
      void loadPocket(store).then(setCash).catch(() => setCash([]));
    };
    load();
    window.addEventListener(FINANCE_EVENT, load);
    window.addEventListener("journal:synced", load);
    return () => {
      window.removeEventListener(FINANCE_EVENT, load);
      window.removeEventListener("journal:synced", load);
    };
  }, [store]);
  const s = useMemo(() => bankState(entries ?? []), [entries]);
  const pocket = useMemo(() => pocketState(cash).balance, [cash]);
  const names = s.accounts.map((a) => a.account);

  const add = async () => {
    const n = Number(amount.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return showToast("The balance needs to be a number", "error");
    setBusy(true);
    try {
      const r = await addBank(store, { account: account.trim() || "Bank", amount: n });
      showToast(`🏦 “${r.line}” in today's [[bank]]`);
      setAmount("");
    } catch (e) {
      showError("Couldn't save the balance", e);
    } finally {
      setBusy(false);
    }
  };

  if (!entries) return <p className="loading">Loading…</p>;
  return (
    <div className="bank-tab">
      <div className="bank-card" aria-live="polite">
        <span className="pocket-icon" aria-hidden>🏦</span>
        <div>
          <strong>{s.total !== null ? r0(s.total) : "—"}</strong>
          <small>{s.total !== null ? `in the bank${s.accounts.length > 1 ? ` (${s.accounts.length} accounts)` : ""}, last set ${when(Math.max(...s.accounts.map((a) => a.at)))}` : "Type your bank balance below to start its history"}</small>
        </div>
      </div>
      <dl className="trend-stats finance-stats bank-split">
        <div>
          <dt>🏦 Bank</dt>
          <dd>{s.total !== null ? r0(s.total) : "—"}</dd>
        </div>
        <div>
          <dt>👛 Pocket cash</dt>
          <dd>{pocket !== null ? r0(pocket) : "—"}</dd>
        </div>
        <div>
          <dt>Together</dt>
          <dd>{s.total !== null || pocket !== null ? r0((s.total ?? 0) + (pocket ?? 0)) : "—"}</dd>
        </div>
      </dl>
      <Trend points={s.totals} />
      <form className="pocket-add bank-add" onSubmit={(e) => (e.preventDefault(), void add())}>
        <input value={account} onChange={(e) => setAccount(e.target.value)} list="bank-accounts" placeholder="Bank" aria-label="Account" />
        <datalist id="bank-accounts">
          {names.map((n) => <option key={n} value={n} />)}
        </datalist>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Balance now ₹" aria-label="Balance now" />
        <button type="submit" className="primary" disabled={busy}>Save</button>
      </form>
      <p className="hint">Goes into today's note under [[bank]], like “Bank balance: 45230”. The ✦ assistant understands “bank balance 45230” too. Cash in the wallet stays in 👛 Pocket.</p>
      {s.accounts.length > 1 && (
        <>
          <h3>Accounts</h3>
          <ul className="finance-list">
            {s.accounts.map((a) => (
              <li key={a.account} className="credit">
                <div className="fl-row">
                  <button type="button" onClick={() => setAccount(a.account)}>
                    <span className="fl-icon">🏦</span>
                    <span className="fl-who">{a.account}<small>{when(a.at)}</small></span>
                    <span className="fl-amt">{r0(a.amount)}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Balance history</h3>
      <ul className="finance-list">
        {s.history.slice(0, 200).map((e, i) => (
          <li key={`${e.day}|${e.at}|${i}`} className={e.change !== null && e.change < 0 ? "debit" : "credit"}>
            <div className="fl-row">
              <button type="button" onClick={() => onOpenDay(e.day)}>
                <span className="fl-icon">🏦</span>
                <span className="fl-who">{e.account}<small>{when(e.at)}{e.change !== null ? ` · ${e.change >= 0 ? "+" : "−"}${r0(Math.abs(e.change))}` : " · first"}</small></span>
                <span className="fl-amt">{r0(e.amount)}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!s.history.length && <p className="hint">No balances yet.</p>}
    </div>
  );
}

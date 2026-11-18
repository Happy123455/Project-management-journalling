import { useEffect, useMemo, useState } from "react";
import type { JournalStore } from "../store";
import { CATEGORY_ICONS, rupees, type Txn } from "../lib/finance";
import { atmTopUps, pocketState, type PocketEntry, type PocketKind } from "../lib/pocket";
import { showError, showToast } from "../lib/toast";
import { addPocket, loadPocket } from "./pocket";
import { FINANCE_EVENT } from "./capture";

const r0 = (n: number) => rupees(n, 0);

/**
 * 👛 Pocket: the physical wallet. Cash spent, cash put in (ATM withdrawals from the bank SMS count
 * by themselves), and a count of the notes in it now and then, which sets what's left. Lines go
 * into today's [[pocket]] box, like Hapi writes them by hand, so the AI agent and the hand agree.
 */
export function PocketTab({ store, txns, onOpenDay }: { store: JournalStore; txns: Txn[]; onOpenDay: (day: string) => void }) {
  const [entries, setEntries] = useState<PocketEntry[] | null>(null);
  const [kind, setKind] = useState<PocketKind>("out");
  const [what, setWhat] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [atm, setAtm] = useState(() => {
    try {
      return localStorage.getItem("journal.pocket.atm") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const load = () => void loadPocket(store).then(setEntries).catch(() => setEntries([]));
    load();
    window.addEventListener(FINANCE_EVENT, load);
    window.addEventListener("journal:synced", load);
    return () => {
      window.removeEventListener(FINANCE_EVENT, load);
      window.removeEventListener("journal:synced", load);
    };
  }, [store]);
  const all = useMemo(() => [...(entries ?? []), ...(atm ? atmTopUps(txns) : [])], [entries, txns, atm]);
  const s = useMemo(() => pocketState(all), [all]);
  const cats = [...s.byCategory.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...cats.map((c) => c[1]));

  const add = async () => {
    const n = Number(amount.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0) return showToast("The amount needs to be a number above 0", "error");
    if (kind === "out" && !what.trim()) return showToast("What was it for?", "error");
    setBusy(true);
    try {
      const r = await addPocket(store, { kind, amount: n, what: kind === "count" ? "Counted" : what.trim() || (kind === "in" ? "Added" : "Spent") });
      showToast(`👛 “${r.line}” in today's [[pocket]]`);
      setWhat("");
      setAmount("");
    } catch (e) {
      showError("Couldn't add it", e);
    } finally {
      setBusy(false);
    }
  };

  if (!entries) return <p className="loading">Loading…</p>;
  const recent = [...all].reverse().slice(0, 120);
  let lastDay = "";
  return (
    <div className="pocket-tab">
      <div className="pocket-wallet" aria-live="polite">
        <span className="pocket-icon" aria-hidden>👛</span>
        <div>
          <strong>{s.balance !== null ? r0(s.balance) : "—"}</strong>
          <small>{s.balance !== null ? `in your pocket (counted ${s.counted ? new Date(s.counted.at).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}, ${s.change >= 0 ? "+" : "−"}${r0(Math.abs(s.change))} since)` : "Count your wallet once to see what's left"}</small>
        </div>
      </div>
      {s.balance !== null && s.balance < 0 && <p className="hint pocket-warn">⚠ Below zero: some cash came in without a line (an ATM withdrawal from another bank, money from someone). Count the wallet again to set it right.</p>}
      <dl className="trend-stats finance-stats">
        <div>
          <dt>Cash today</dt>
          <dd>{r0(s.spentToday)}</dd>
        </div>
        <div>
          <dt>Cash this month</dt>
          <dd>{r0(s.spentMonth)}</dd>
        </div>
      </dl>
      <form className="pocket-add" onSubmit={(e) => (e.preventDefault(), void add())}>
        <div className="fl-edit-dir" role="radiogroup" aria-label="What happened">
          {(
            [
              ["out", "💸 Spent"],
              ["in", "➕ Put in"],
              ["count", "🧮 Counted"],
            ] as [PocketKind, string][]
          ).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>
        {kind !== "count" && <input value={what} onChange={(e) => setWhat(e.target.value)} placeholder={kind === "out" ? "Hair cut and beard" : "From ATM / from Mom"} aria-label="What" />}
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={kind === "count" ? "Cash in the wallet now" : "₹"} aria-label="Amount" />
        <button type="submit" className="primary" disabled={busy}>Add</button>
      </form>
      <p className="hint">Goes into today's note under [[pocket]], like “Hair cut and beard: 350”. You can also tell the ✦ assistant: “haircut 350 from my pocket”.</p>
      {cats.length > 0 && (
        <>
          <h3>Cash this month</h3>
          <ul className="finance-cats">
            {cats.map(([c, v]) => (
              <li key={c}>
                <span className="fc-name">{CATEGORY_ICONS[c] ?? "💸"} {c}</span>
                <span className="fc-bar"><i style={{ width: `${(v / maxCat) * 100}%` }} /></span>
                <span className="fc-val">{r0(v)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Pocket list</h3>
      <ul className="finance-list">
        {recent.map((e, i) => {
          const head = e.day !== lastDay;
          lastDay = e.day;
          return (
            <li key={`${e.day}|${e.at}|${i}`} className={e.kind === "out" ? "debit" : "credit"}>
              {head && <h4>{new Date(e.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</h4>}
              <div className="fl-row">
                <button type="button" onClick={() => onOpenDay(e.day)}>
                  <span className="fl-icon">{e.kind === "count" ? "🧮" : e.kind === "in" ? "➕" : CATEGORY_ICONS[e.category] ?? "💸"}</span>
                  <span className="fl-who">{e.what}<small>{e.kind === "count" ? "counted" : e.category}</small></span>
                  <span className="fl-amt">{e.kind === "count" ? "=" : e.kind === "in" ? "+" : "−"}{rupees(e.amount)}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {!recent.length && <p className="hint">Nothing yet. Add a line under [[pocket]] in any day's note, or above.</p>}
      <label className="pocket-atm">
        <input
          type="checkbox"
          checked={atm}
          onChange={(e) => {
            setAtm(e.target.checked);
            try {
              localStorage.setItem("journal.pocket.atm", e.target.checked ? "on" : "off");
            } catch {
              // Only this session.
            }
          }}
        />
        ATM withdrawals from bank SMS go into the pocket
      </label>
      <details className="pocket-ideas">
        <summary>Ways to tie it to the real wallet</summary>
        <ul>
          <li>🏧 ATM cash from your bank SMS is added for you (above).</li>
          <li>🧮 Count the notes now and then (“Counted”): the difference from what the journal expected shows cash you forgot to write.</li>
          <li>✦ Say it on the go: hold Home and say “chai 20 from pocket”, or on the watch.</li>
          <li>🏷️ An NFC sticker in the wallet: tapping the phone on it can open this tab (next step if you want it).</li>
        </ul>
      </details>
    </div>
  );
}

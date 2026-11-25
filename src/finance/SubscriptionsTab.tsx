import { useEffect, useMemo, useState } from "react";
import type { JournalStore } from "../store";
import { rupees, type Txn } from "../lib/finance";
import { findSubscriptions, mergeSubscriptions, monthView, type Subscription } from "../lib/subscriptions";
import { dayTint } from "../lib/bankStatement";
import { showError } from "../lib/toast";
import { FINANCE_EVENT } from "./capture";

/** 🔁 Subscriptions: what renews this month, what's paid, what's still coming, and the year's cost. */
const FILE = "subscriptions.json";
const r0 = (n: number) => rupees(n, 0);

async function loadSaved(store: JournalStore): Promise<Subscription[]> {
  const rec = await store.findFile(FILE);
  const bytes = rec ? await store.fileBytes(rec.id) : null;
  if (!bytes) return [];
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
async function saveSaved(store: JournalStore, list: Subscription[]) {
  await store.saveFile({ name: FILE, mime: "application/json", bytes: new TextEncoder().encode(JSON.stringify(list)) });
  window.dispatchEvent(new CustomEvent(FINANCE_EVENT, { detail: { subs: true } }));
}

export function SubscriptionsTab({ store, txns }: { store: JournalStore; txns: Txn[] }) {
  const [saved, setSaved] = useState<Subscription[] | null>(null);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(String(new Date().getDate()));
  const [yearly, setYearly] = useState(false);
  useEffect(() => {
    const load = () => void loadSaved(store).then(setSaved).catch(() => setSaved([]));
    load();
    window.addEventListener("journal:synced", load);
    return () => window.removeEventListener("journal:synced", load);
  }, [store]);
  const subs = useMemo(() => mergeSubscriptions(saved ?? [], findSubscriptions(txns)), [saved, txns]);
  const v = useMemo(() => monthView(subs, txns, month.y, month.m), [subs, txns, month]);
  const today = new Date();
  const thisMonth = today.getFullYear() === month.y && today.getMonth() === month.m;
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const last = new Date(month.y, month.m + 1, 0).getDate();

  const write = async (next: Subscription[]) => {
    setSaved(next);
    try {
      await saveSaved(store, next);
    } catch (e) {
      showError("Couldn't save subscriptions", e);
    }
  };
  const add = async () => {
    const n = Number(amount.replace(/[₹,\s]/g, ""));
    const d = Math.min(31, Math.max(1, Number(day) || 1));
    if (!name.trim() || !(n > 0)) return;
    await write([...(saved ?? []), { id: `m${Date.now().toString(36)}`, name: name.trim(), amount: n, day: d, cycle: yearly ? "yearly" : "monthly", match: name.trim().toLowerCase() }]);
    setName("");
    setAmount("");
  };
  const remove = (s: Subscription) => void write(s.found ? [...(saved ?? []), { ...s, off: true }] : (saved ?? []).filter((x) => x.id !== s.id));
  const shift = (k: number) => setMonth(({ y, m }) => ({ y: m + k < 0 ? y - 1 : m + k > 11 ? y + 1 : y, m: (m + k + 12) % 12 }));

  if (!saved) return <p className="loading">Loading…</p>;
  const title = new Date(month.y, month.m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return (
    <div className="subs-tab">
      <div className="bank-scrub">
        <button type="button" aria-label="Month before" onClick={() => shift(-1)}>‹</button>
        <div>
          <strong>{title}</strong>
          <small>{r0(v.total)} a month · {r0(v.perYear)} a year</small>
        </div>
        <button type="button" aria-label="Month after" onClick={() => shift(1)}>›</button>
      </div>
      <dl className="trend-stats finance-stats bank-split">
        <div><dt>This month</dt><dd>{r0(v.total)}</dd></div>
        <div><dt>Paid</dt><dd>{r0(v.paid)}</dd></div>
        <div><dt>Still to come</dt><dd>{r0(v.due)}</dd></div>
      </dl>
      {/* The month as a strip: each renewal on its day, coloured by the day of the month. */}
      <div className="subs-strip" aria-hidden>
        {Array.from({ length: last }, (_, i) => {
          const key = `${month.y}-${String(month.m + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
          const here = v.rows.filter((r) => r.due === key);
          return (
            <span key={key} className={`subs-cell${key === todayKey ? " today" : ""}${here.length ? " on" : ""}`} style={here.length ? { background: dayTint(key, here.every((r) => r.paid) ? 0.45 : 0.9) } : undefined} title={here.map((r) => r.sub.name).join(", ")}>
              {i + 1}
            </span>
          );
        })}
      </div>
      <ul className="finance-list subs-list">
        {v.rows.map((r) => {
          const late = thisMonth && !r.paid && r.due && r.due < todayKey;
          return (
            <li key={r.sub.id} className={r.paid ? "credit" : late ? "debit" : ""}>
              <div className="fl-row">
                <span className="subs-dot" style={{ background: r.due ? dayTint(r.due) : "var(--border)" }} />
                <span className="fl-who">
                  {r.sub.name}
                  <small>
                    {r.sub.cycle === "yearly" ? `yearly ${r0(r.sub.amount)}` : `on the ${r.sub.day}${["th", "st", "nd", "rd"][r.sub.day % 10 > 3 || [11, 12, 13].includes(r.sub.day) ? 0 : r.sub.day % 10]}`}
                    {" · "}
                    {r.paid ? `✓ paid ${new Date(r.paid.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : late ? "⚠ not seen yet" : "coming"}
                    {r.sub.found ? " · found in payments" : ""}
                  </small>
                </span>
                <span className="fl-amt">{r0(r.perMonth)}</span>
                <button type="button" className="link" onClick={() => remove(r.sub)} aria-label={`Remove ${r.sub.name}`}>✕</button>
              </div>
            </li>
          );
        })}
      </ul>
      {!v.rows.length && <p className="hint">No subscriptions yet. Add one below; ones you pay every month are found in your payments too.</p>}
      <form className="pocket-add subs-add" onSubmit={(e) => (e.preventDefault(), void add())}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Gemini Pro" aria-label="Name" />
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹" aria-label="Amount" />
        <input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} placeholder="Day" aria-label="Renews on day" style={{ maxWidth: 56 }} />
        <label className="subs-yearly"><input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} /> yearly</label>
        <button type="submit" className="primary">Add</button>
      </form>
    </div>
  );
}

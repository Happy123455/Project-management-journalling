import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { askAi, AiUnavailableError } from "../ai/client";
import { dayKey } from "../lib/timestamp";
import { showError, showToast } from "../lib/toast";
import { CATEGORY_ICONS, dailySpend, forecastMonth, IGNORED, monthly, notSpending, rewriteLine, rupees, topPayees, type Direction, type Txn } from "../lib/finance";
import { editDayLine } from "../routine/routineData";
import { STEP_COLORS } from "../routine/charts";
import {
  FINANCE_EVENT, importMoney, loadTxns, moneySettings, notificationsReady, onPhone, setMoneySettings, smsReady,
} from "./capture";
import { useEscapeToClose } from "../ui/useEscapeToClose";

type Tab = "overview" | "list" | "insights" | "setup";
const r0 = (n: number) => rupees(n, 0);
const monthName = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: "short" });
const thisMonth = () => dayKey(new Date()).slice(0, 7);

/** 💰 Money: what came in and went out (from bank SMS and payment notifications in the notes), charts and AI insights. */
export function FinancePanel({ store, onClose, onOpenDay }: { store: JournalStore; onClose: () => void; onOpenDay: (day: string) => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [txns, setTxns] = useState<Txn[] | null>(null);
  useEscapeToClose(onClose);
  useEffect(() => {
    const load = () => void loadTxns(store).then(setTxns).catch(() => setTxns([]));
    load();
    // The phone brings in anything new when the panel opens.
    if (onPhone()) void importMoney(store).catch(() => {});
    window.addEventListener(FINANCE_EVENT, load);
    window.addEventListener("journal:synced", load);
    return () => {
      window.removeEventListener(FINANCE_EVENT, load);
      window.removeEventListener("journal:synced", load);
    };
  }, [store]);
  return createPortal(
    <>
      <div className="outline-backdrop" onClick={onClose} />
      <aside className="routine-panel finance-panel" role="dialog" aria-label="Money">
        <header>
          <strong>💰 Money</strong>
          <nav>
            {(["overview", "list", "insights", "setup"] as Tab[]).map((t) => (
              <button key={t} type="button" className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {{ overview: "Overview", list: "Payments", insights: "Insights", setup: "Setup" }[t]}
              </button>
            ))}
          </nav>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="routine-body">
          {!txns ? (
            <p className="loading">Loading…</p>
          ) : tab === "overview" ? (
            <Overview txns={txns} onSetup={() => setTab("setup")} />
          ) : tab === "list" ? (
            <Payments store={store} txns={txns} onOpenDay={(d) => (onOpenDay(d), onClose())} />
          ) : tab === "insights" ? (
            <Insights txns={txns} />
          ) : (
            <Setup store={store} />
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

/** Categories by how much went to them this month; a fixed colour per category (from its place in the year's list), never by rank. */
function useCategoryColors(txns: Txn[]) {
  return useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of txns) if (t.direction === "debit") totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
    const order = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const colors = new Map<string, string>();
    order.forEach((c, i) => colors.set(c, i < STEP_COLORS.length - 1 ? STEP_COLORS[i] : "#8a8a85"));
    return colors;
  }, [txns]);
}

function Overview({ txns, onSetup }: { txns: Txn[]; onSetup: () => void }) {
  const months = useMemo(() => monthly(txns), [txns]);
  const colors = useCategoryColors(txns);
  const now = new Date();
  const cur = months.find((m) => m.month === thisMonth());
  const prev = months.filter((m) => m.month < thisMonth()).pop();
  const forecast = useMemo(() => forecastMonth(txns, now), [txns]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => dailySpend(txns, now, 30), [txns]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!txns.length) {
    return (
      <div className="finance-empty">
        <p>No payments in the notes yet.</p>
        <p className="hint">On the phone, turn on bank SMS and payment notifications in Setup: every payment then lands in that day's note in a [[Finance]] box. You can also type one: “💸 ₹40 to chai #food”.</p>
        <button type="button" className="primary" onClick={onSetup}>Set up</button>
      </div>
    );
  }
  const cats = cur ? [...cur.byCategory.entries()].filter(([c]) => !notSpending(c)).sort((a, b) => b[1] - a[1]) : [];
  const maxCat = Math.max(1, ...cats.map((c) => c[1]));
  return (
    <>
      <dl className="trend-stats finance-stats">
        <div>
          <dt>Spent this month</dt>
          <dd>{r0(cur?.spent ?? 0)}</dd>
        </div>
        <div>
          <dt>Came in</dt>
          <dd>{r0(cur?.received ?? 0)}</dd>
        </div>
        <div>
          <dt>Heading for</dt>
          <dd>{forecast ? r0(forecast.projected) : "—"}</dd>
        </div>
        <div>
          <dt>Last month</dt>
          <dd>{prev ? r0(prev.spent) : "—"}</dd>
        </div>
      </dl>
      {forecast && (
        <p className="routine-now">
          About <strong>{r0(forecast.perDay)}</strong> a day on usual days.
          {prev && prev.spent > 0 && <> This month is heading {forecast.projected > prev.spent ? "above" : "below"} last month by <strong>{r0(Math.abs(forecast.projected - prev.spent))}</strong>.</>}
        </p>
      )}
      <h3>Last 30 days</h3>
      <DailyBars days={days} />
      {cats.length > 0 && (
        <>
          <h3>Where it went this month</h3>
          <ul className="finance-cats">
            {cats.map(([c, v]) => (
              <li key={c}>
                <span className="fc-name">{CATEGORY_ICONS[c] ?? "💸"} {c}</span>
                <span className="fc-bar"><i style={{ width: `${(v / maxCat) * 100}%`, background: colors.get(c) ?? "#8a8a85" }} /></span>
                <span className="fc-val">{r0(v)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {months.length > 1 && (
        <>
          <h3>Month by month</h3>
          <MonthBars months={months.slice(-6)} />
        </>
      )}
    </>
  );
}

/** Spending per day: one bar a day, hover or touch for the amount; a dashed line at the 30-day average. */
function DailyBars({ days }: { days: { day: Date; spent: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 120;
  const pad = { l: 34, r: 4, t: 8, b: 16 };
  const max = Math.max(1, ...days.map((d) => d.spent));
  const avg = days.reduce((a, d) => a + d.spent, 0) / days.length;
  const step = (W - pad.l - pad.r) / days.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const shown = hover !== null ? days[hover] : null;
  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spending per day, last 30 days" onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end" className="axis">{max * f >= 1000 ? `${Math.round((max * f) / 100) / 10}k` : Math.round(max * f)}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const h = Math.max(0, y(0) - y(d.spent));
          return <rect key={i} x={pad.l + i * step + 1} y={y(d.spent)} width={Math.max(2, step - 2)} height={h} rx={Math.min(3, (step - 2) / 2)} className={hover === i ? "bar on" : "bar"} />;
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(avg)} y2={y(avg)} className="curve ahead" />
        {[0, 14, 29].map((i) => (
          <text key={i} x={pad.l + i * step + step / 2} y={H - 3} textAnchor="middle" className="axis">{days[i].day.getDate()}/{days[i].day.getMonth() + 1}</text>
        ))}
        {days.map((_, i) => <rect key={`h${i}`} x={pad.l + i * step} y={0} width={step} height={H} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />)}
      </svg>
      <p className="trend-tip" aria-live="polite">
        {shown ? <><strong>{r0(shown.spent)}</strong> · {shown.day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</> : <>Dashed line: average {r0(avg)} a day</>}
      </p>
    </div>
  );
}

/** Spent and came in, side by side per month. */
function MonthBars({ months }: { months: { month: string; spent: number; received: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 130;
  const pad = { l: 34, r: 4, t: 8, b: 16 };
  const max = Math.max(1, ...months.flatMap((m) => [m.spent, m.received]));
  const step = (W - pad.l - pad.r) / months.length;
  const bw = Math.min(16, (step - 8) / 2);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const shown = hover !== null ? months[hover] : null;
  return (
    <div className="trend-chart">
      <ul className="phase-legend">
        <li><i style={{ background: STEP_COLORS[1] }} />Spent</li>
        <li><i style={{ background: STEP_COLORS[2] }} />Came in</li>
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spent and received per month" onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end" className="axis">{max * f >= 1000 ? `${Math.round((max * f) / 100) / 10}k` : Math.round(max * f)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = pad.l + i * step + step / 2;
          return (
            <g key={m.month}>
              <rect x={cx - bw - 1} y={y(m.spent)} width={bw} height={Math.max(0, y(0) - y(m.spent))} rx={3} fill={STEP_COLORS[1]} opacity={hover === null || hover === i ? 1 : 0.5} />
              <rect x={cx + 1} y={y(m.received)} width={bw} height={Math.max(0, y(0) - y(m.received))} rx={3} fill={STEP_COLORS[2]} opacity={hover === null || hover === i ? 1 : 0.5} />
              <text x={cx} y={H - 3} textAnchor="middle" className="axis">{monthName(m.month)}</text>
              <rect x={cx - step / 2} y={0} width={step} height={H} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      <p className="trend-tip" aria-live="polite">{shown ? <><strong>{monthName(shown.month)}</strong>: spent {r0(shown.spent)}, came in {r0(shown.received)}</> : " "}</p>
    </div>
  );
}

/** A payment corrected by hand: the line in its day's note is rewritten (so it syncs like any edit). */
function EditPayment({ store, t, cats, onDone }: { store: JournalStore; t: Txn; cats: string[]; onDone: () => void }) {
  const [amount, setAmount] = useState(String(t.amount));
  const [direction, setDirection] = useState<Direction>(t.direction);
  const [party, setParty] = useState(t.party ?? "");
  const [category, setCategory] = useState(t.category);
  const time0 = new Date(t.at).toTimeString().slice(0, 5);
  const [time, setTime] = useState(time0);
  const [busy, setBusy] = useState(false);
  const write = async (patch: Parameters<typeof rewriteLine>[2], done: string) => {
    if (!t.line || !t.day) return showToast("This payment isn't in a note, so it can't be changed here", "error");
    const next = rewriteLine(t.line, t.day, patch);
    if (!next) return showToast("Couldn't read that payment's line", "error");
    setBusy(true);
    try {
      const ok = next === t.line || (await editDayLine(store, t.day, t.line, { index: 0, del: t.line.length, ins: next }));
      if (!ok) return showToast("That payment's line changed in the note meanwhile: open the day to fix it there", "error");
      window.dispatchEvent(new CustomEvent(FINANCE_EVENT, { detail: { edited: 1 } }));
      showToast(done);
      onDone();
    } catch (e) {
      showError("Couldn't save the payment", e);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const n = Number(amount.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0) return showToast("The amount needs to be a number above 0", "error");
    // The time only when it was changed, so a line without a timestamp doesn't gain one.
    void write({ amount: n, direction, party, category, time: time !== time0 ? time : undefined }, "Payment updated");
  };
  return (
    <form className="fl-edit" onSubmit={(e) => (e.preventDefault(), save())}>
      <div className="fl-edit-dir" role="radiogroup" aria-label="Money">
        <button type="button" role="radio" aria-checked={direction === "debit"} className={direction === "debit" ? "active" : ""} onClick={() => setDirection("debit")}>💸 Spent</button>
        <button type="button" role="radio" aria-checked={direction === "credit"} className={direction === "credit" ? "active" : ""} onClick={() => setDirection("credit")}>💰 Came in</button>
      </div>
      <label>Amount (₹)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>{direction === "debit" ? "To" : "From"}<input value={party} onChange={(e) => setParty(e.target.value)} placeholder="Who" /></label>
      <label>
        Category
        <input list="fl-cats" value={category} onChange={(e) => setCategory(e.target.value)} />
        <datalist id="fl-cats">{[...new Set([...cats, ...Object.keys(CATEGORY_ICONS)])].map((c) => <option key={c} value={c} />)}</datalist>
      </label>
      <label>Time<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      <div className="fl-edit-actions">
        <button type="submit" className="primary" disabled={busy}>Save</button>
        <button type="button" disabled={busy} onClick={() => void write({ category: IGNORED }, "Marked as not a payment: it stays in the note but isn't counted")}>Not a payment</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
      {t.line && <p className="hint fl-edit-line">In the note: {t.line}</p>}
    </form>
  );
}

function Payments({ store, txns, onOpenDay }: { store: JournalStore; txns: Txn[]; onOpenDay: (day: string) => void }) {
  const [cat, setCat] = useState<string>("");
  const [editing, setEditing] = useState<string | null>(null);
  const cats = [...new Set(txns.map((t) => t.category))].sort();
  const list = txns.filter((t) => !cat || t.category === cat).slice(-200).reverse();
  let lastDay = "";
  const keyOf = (t: Txn, i: number) => `${t.day ?? ""}|${t.line ?? t.at}|${i}`;
  return (
    <>
      <div className="trend-picks" role="radiogroup" aria-label="Category">
        <button type="button" role="radio" aria-checked={!cat} className={!cat ? "active" : ""} onClick={() => setCat("")}>All</button>
        {cats.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={cat === c} className={cat === c ? "active" : ""} onClick={() => setCat(c)}>{CATEGORY_ICONS[c] ?? "💸"} {c}</button>
        ))}
      </div>
      <p className="hint">Tap ✎ to correct a payment (amount, who, category, time), or to mark it as not a payment.</p>
      <ul className="finance-list">
        {list.map((t, i) => {
          const day = t.day ?? dayKey(new Date(t.at));
          const head = day !== lastDay;
          lastDay = day;
          const k = keyOf(t, i);
          return (
            <li key={k} className={`${t.direction}${editing === k ? " editing" : ""}`}>
              {head && <h4>{new Date(t.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</h4>}
              <div className="fl-row">
                <button type="button" onClick={() => onOpenDay(day)}>
                  <span className="fl-icon">{CATEGORY_ICONS[t.category] ?? "💸"}</span>
                  <span className="fl-who">{t.party ?? t.category}<small>{[new Date(t.at).toTimeString().slice(0, 5), t.bank, t.method].filter(Boolean).join(" · ")}</small></span>
                  <span className="fl-amt">{t.direction === "credit" ? "+" : "−"}{rupees(t.amount)}</span>
                </button>
                {t.line && (
                  <button type="button" className="fl-edit-btn" aria-label="Edit payment" title="Edit" onClick={() => setEditing(editing === k ? null : k)}>✎</button>
                )}
              </div>
              {editing === k && <EditPayment store={store} t={t} cats={cats} onDone={() => setEditing(null)} />}
            </li>
          );
        })}
      </ul>
      {!list.length && <p className="hint">Nothing here yet.</p>}
    </>
  );
}

interface InsightAnswer {
  patterns: string[];
  forecast: string;
  suggestions: string[];
}
const INSIGHT_KEY = "journal.money.insights";

/** Gemini looks at the totals (never the messages themselves) and says what it sees, where it's heading and what to change. */
function Insights({ txns }: { txns: Txn[] }) {
  const [answer, setAnswer] = useState<{ at: string; a: InsightAnswer } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(INSIGHT_KEY) ?? "null");
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const now = new Date();
      const months = monthly(txns).slice(-6).map((m) => ({ month: m.month, spent: Math.round(m.spent), received: Math.round(m.received), byCategory: Object.fromEntries([...m.byCategory].map(([k, v]) => [k, Math.round(v)])) }));
      const last30 = dailySpend(txns, now, 30).map((d) => Math.round(d.spent));
      const weekdays = [0, 0, 0, 0, 0, 0, 0];
      for (const t of txns) if (t.direction === "debit" && !notSpending(t.category) && now.getTime() - t.at < 90 * 86_400_000) weekdays[new Date(t.at).getDay()] += t.amount;
      const summary = {
        today: dayKey(now),
        currency: "INR",
        months,
        last30DaysSpendPerDay: last30,
        spendByWeekdayLast90Days: Object.fromEntries(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => [d, Math.round(weekdays[i])])),
        topPayeesLast90Days: topPayees(txns.filter((t) => now.getTime() - t.at < 90 * 86_400_000), 8).map((p) => ({ ...p, total: Math.round(p.total) })),
        forecastThisMonth: forecastMonth(txns, now),
      };
      const a = await askAi<InsightAnswer>({
        task: "organise",
        cloud: true,
        system:
          "You are a calm, practical personal-finance helper for a student/young professional in India. You get spending totals (INR) from their journal. " +
          "Reply in JSON: 'patterns' = 3-5 short observations backed by the numbers (when, where, how it's changing); 'forecast' = one or two sentences on where this month and next are heading, with a number; " +
          "'suggestions' = 3-5 specific, doable changes with the rupees each would save a month. No judgement, no generic advice, no investment product recommendations.",
        text: JSON.stringify(summary),
        schema: {
          type: "object",
          properties: { patterns: { type: "array", items: { type: "string" } }, forecast: { type: "string" }, suggestions: { type: "array", items: { type: "string" } } },
          required: ["patterns", "forecast", "suggestions"],
        },
        maxTokens: 2000,
      });
      const next = { at: new Date().toLocaleString(), a: a.json };
      setAnswer(next);
      try {
        localStorage.setItem(INSIGHT_KEY, JSON.stringify(next));
      } catch {
        // Shown now anyway.
      }
    } catch (e) {
      if (e instanceof AiUnavailableError) showToast("Insights need AI: turn it on in Settings → AI (Gemini key).");
      else showError("Couldn't get insights", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="hint">Gemini gets only the totals: per month and category, per day, per weekday and your biggest payees. Never the messages, account numbers or references.</p>
      <button type="button" className="primary" disabled={busy || txns.length < 5} onClick={() => void run()}>{busy ? "Looking…" : answer ? "↻ Look again" : "✨ What does Gemini see?"}</button>
      {txns.length < 5 && <p className="hint">A few more payments first.</p>}
      {answer && (
        <div className="finance-insights">
          <h3>Patterns</h3>
          <ul>{answer.a.patterns.map((p, i) => <li key={i}>{p}</li>)}</ul>
          <h3>Where it's heading</h3>
          <p>{answer.a.forecast}</p>
          <h3>What could change</h3>
          <ul>{answer.a.suggestions.map((p, i) => <li key={i}>{p}</li>)}</ul>
          <p className="hint">From {answer.at}</p>
        </div>
      )}
    </>
  );
}

function Setup({ store }: { store: JournalStore }) {
  const [s, setS] = useState(moneySettings());
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Back from Android's settings or the permission prompt: show the new state.
    const f = () => setTick((n) => n + 1);
    document.addEventListener("visibilitychange", f);
    window.addEventListener("journal:finance-access", f);
    return () => {
      document.removeEventListener("visibilitychange", f);
      window.removeEventListener("journal:finance-access", f);
    };
  }, []);
  const phone = onPhone();
  const toggle = (k: "sms" | "notifications", on: boolean) => {
    if (on && k === "sms" && !smsReady()) window.JournalFinance?.askSms();
    if (on && k === "notifications" && !notificationsReady()) window.JournalFinance?.openNotifyAccess();
    setS(setMoneySettings({ [k]: on, ...(on && k === "sms" && !s.lastSms ? { lastSms: Date.now() - 2 * 86_400_000 } : {}) }));
  };
  const bringIn = async (days: number) => {
    setBusy(true);
    try {
      const n = await importMoney(store, Date.now() - days * 86_400_000);
      showToast(n ? `${n} payment${n === 1 ? "" : "s"} added to your notes` : "Nothing new found");
    } catch (e) {
      showError("Couldn't read the messages", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!phone && <p className="routine-care">Payments are read on the phone (bank SMS and payment notifications) and reach this Mac through sync. Google Pay has no public API for personal transactions, so this is the reliable way in.</p>}
      <label className="setup-toggle">
        <input type="checkbox" checked={s.sms} disabled={!phone} onChange={(e) => toggle("sms", e.target.checked)} />
        <span>
          Bank SMS alerts {phone && s.sms && <em>{smsReady() ? "· allowed" : "· waiting for permission"}</em>}
          <br />
          <small>Every debit and credit your bank texts you (UPI including Google Pay, cards, NEFT, ATM). OTPs, offers, requests and due-date reminders are skipped. Messages stay on the phone; only the payment line goes into your note.</small>
        </span>
      </label>
      <label className="setup-toggle">
        <input type="checkbox" checked={s.notifications} disabled={!phone} onChange={(e) => toggle("notifications", e.target.checked)} />
        <span>
          Payment app notifications {phone && s.notifications && <em>{notificationsReady() ? "· allowed" : "· allow “Dynamic Journal” in the list that opened"}</em>}
          <br />
          <small>Google Pay, PhonePe, Paytm, BHIM, CRED and bank apps. Catches small UPI payments some banks don't text about. A payment seen in both is written once.</small>
        </span>
      </label>
      {phone && (s.sms || s.notifications) && (
        <div className="phase-new">
          <button type="button" disabled={busy || !s.sms} onClick={() => void bringIn(30)}>Bring in the last 30 days</button>
          <button type="button" disabled={busy || !s.sms} onClick={() => void bringIn(90)}>Last 90 days</button>
        </div>
      )}
      <h3>How it works</h3>
      <ul className="finance-how">
        <li>Each payment becomes a line in that day's note, in a [[Finance]] box: “💸 ₹250.00 to Swiggy #food (HDFC ••1234 · UPI)”.</li>
        <li>Change the #tag in the note to re-file it (#food → #travel). Type your own cash spends the same way: “💸 ₹40 to chai #food”.</li>
        <li>Limits: only what your bank or payment app tells the phone; bank SMS formats vary, so an unusual one may be missed; notifications only count while access is on, and the phone keeps up to 400 until the journal next opens.</li>
      </ul>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { JournalStore } from "../store";
import { rupees } from "../lib/finance";
import { balanceDays, dayTint, marginInfo, type DayBalance, type SavedStatements } from "../lib/bankStatement";
import { showError, showToast } from "../lib/toast";
import { announceMargin } from "./BankAlert";
import { importStatement, isPasswordError, readMargin, saveMargin } from "./bankStatement";

const r2 = (n: number) => rupees(n, 2);
const r0 = (n: number) => rupees(n, 0);
const dayDate = (day: string) => new Date(`${day}T12:00:00`);
const longDay = (day: string) => dayDate(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDay = (day: string) => dayDate(day).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${r2(Math.abs(n))}`;

/** End-of-day balance as steps, the safety margin as a dashed line, drag/tap to go back to a day. */
function HistoryChart({ days, margin, pick, onPick }: { days: DayBalance[]; margin: number; pick: number; onPick: (i: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const w = 320;
  const h = 120;
  const t = (d: string) => dayDate(d).getTime();
  const t0 = t(days[0].day);
  const t1 = Math.max(t0 + 86400000, t(days[days.length - 1].day));
  const vals = days.flatMap((d) => [d.open, d.close, d.low]);
  const lo = Math.min(margin, ...vals) * 0.94;
  const hi = Math.max(margin, ...vals) * 1.04;
  const x = (ms: number) => ((ms - t0) / (t1 - t0)) * (w - 12) + 6;
  const y = (v: number) => h - 14 - ((v - lo) / Math.max(1, hi - lo)) * (h - 24);
  let d = `M${x(t0).toFixed(1)},${y(days[0].open).toFixed(1)}`;
  for (const day of days) {
    const xx = x(t(day.day)).toFixed(1);
    d += ` H${xx} V${y(day.close).toFixed(1)}`;
  }
  d += ` H${(w - 6).toFixed(1)}`;
  const my = y(margin);
  const sel = days[pick];
  const sx = x(t(sel.day));
  const pickAt = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const ms = t0 + ((((clientX - box.left) / box.width) * w - 6) / (w - 12)) * (t1 - t0);
    let best = 0;
    for (let i = 0; i < days.length; i++) if (Math.abs(t(days[i].day) - ms) < Math.abs(t(days[best].day) - ms)) best = i;
    if (best !== pick) onPick(best);
  };
  return (
    <svg
      ref={ref}
      className="bank-history-chart"
      viewBox={`0 0 ${w} ${h}`}
      role="slider"
      aria-label="Balance history: drag to go back in time"
      aria-valuemin={0}
      aria-valuemax={days.length - 1}
      aria-valuenow={pick}
      aria-valuetext={`${longDay(sel.day)}: ${r2(sel.close)}`}
      tabIndex={0}
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        pickAt(e.clientX);
      }}
      onPointerMove={(e) => e.buttons && pickAt(e.clientX)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") (e.preventDefault(), onPick(Math.max(0, pick - 1)));
        if (e.key === "ArrowRight") (e.preventDefault(), onPick(Math.min(days.length - 1, pick + 1)));
      }}
    >
      <defs>
        <clipPath id="bank-under">
          <rect x="0" y={my} width={w} height={Math.max(0, h - my)} />
        </clipPath>
      </defs>
      {days.map((day, i) => {
        const x0 = x(t(day.day));
        const x1 = i + 1 < days.length ? x(t(days[i + 1].day)) : w - 6;
        const top = y(day.close);
        return <rect key={day.day} className="bh-tint" x={x0} y={top} width={Math.max(0.6, x1 - x0)} height={Math.max(0, h - 12 - top)} fill={dayTint(day.day, 0.42)} />;
      })}
      <rect className="bh-danger" x="0" y={my} width={w} height={Math.max(0, h - 10 - my)} />
      <line className="bh-margin" x1="0" x2={w} y1={my} y2={my} />
      <text className="bh-margin-label" x={w - 6} y={my - 4} textAnchor="end">safety {r0(margin)}</text>
      <path className="bh-line" d={d} />
      <path className="bh-line bh-line-under" d={d} clipPath="url(#bank-under)" />
      <line className="bh-cursor" x1={sx} x2={sx} y1="4" y2={h - 12} />
      <circle className={sel.close < margin ? "bh-dot under" : "bh-dot"} cx={sx} cy={y(sel.close)} r="4.5" />
      <text className="bh-axis" x="6" y={h - 1}>{shortDay(days[0].day)}</text>
      <text className="bh-axis" x={w - 6} y={h - 1} textAnchor="end">{shortDay(days[days.length - 1].day)}</text>
    </svg>
  );
}

/**
 * 🏦 Statement history (Hapi, 18 Nov): import the bank's PDF statement, then drag along the chart
 * (or scroll the list) to see what the account held on any day and the entries around it, against
 * a safety margin (₹15,000 by default).
 */
export function BankHistory({ store, saved, onSaved, onOpenDay }: { store: JournalStore; saved: SavedStatements | null; onSaved: (s: SavedStatements) => void; onOpenDay: (day: string) => void }) {
  const [margin, setMargin] = useState(readMargin);
  const [marginText, setMarginText] = useState(String(readMargin()));
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fromChart = useRef(false);

  const days = useMemo(() => balanceDays(saved), [saved]);
  const info = useMemo(() => marginInfo(days, margin), [days, margin]);
  const at = pick === null ? days.length - 1 : Math.min(pick, days.length - 1);
  const sel = days[at];

  // Chart → list: bring the picked day into view.
  useEffect(() => {
    if (!fromChart.current || !sel) return;
    fromChart.current = false;
    listRef.current?.querySelector(`[data-day="${sel.day}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [sel]);

  const run = async (bytes: Uint8Array, pw?: string) => {
    setBusy(true);
    try {
      const r = await importStatement(store, bytes, pw);
      onSaved(r.saved);
      setPick(null);
      setLocked(null);
      setPassword("");
      const end = r.parsed.closing !== null ? `, closing ${r2(r.parsed.closing)}` : "";
      showToast(`🏦 ${r.added} new entr${r.added === 1 ? "y" : "ies"} from the statement${end}${r.parsed.mismatches ? ` · ${r.parsed.mismatches} row(s) didn't add up, check them` : ""}`);
    } catch (e) {
      if (isPasswordError(e)) {
        setLocked(bytes);
        if (pw) showToast("That password didn't open it", "error");
      } else showError("Couldn't read that statement", e);
    } finally {
      setBusy(false);
    }
  };

  const setNewMargin = () => {
    const n = Number(marginText.replace(/[₹,\s]/g, "").replace(/k$/i, "000"));
    if (!Number.isFinite(n) || n < 0) return setMarginText(String(margin));
    setMargin(n);
    saveMargin(n);
    announceMargin();
  };

  const last = days[days.length - 1];
  const gap = last ? last.close - margin : 0;
  const stTo = saved?.periods.reduce((m, p) => (p.to && p.to > m ? p.to : m), "") ?? "";
  const fromMsgs = stTo ? (saved?.txns.filter((t) => t.day > stTo).length ?? 0) : 0;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  // The balance bar: full at twice the safety margin, the safety line at its middle.
  const fill = last ? Math.max(0, Math.min(1, last.close / Math.max(1, margin * 2))) : 0;

  return (
    <section className="bank-history">
      <div className="bank-history-head">
        <h3>Statement history</h3>
        <button type="button" className="chip" disabled={busy} onClick={() => file.current?.click()}>{busy ? "Reading…" : days.length ? "＋ Statement" : "Import statement PDF"}</button>
        <input ref={file} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void f.arrayBuffer().then((b) => run(new Uint8Array(b)));
        }} />
      </div>
      {locked && (
        <form className="pocket-add bank-pw" onSubmit={(e) => (e.preventDefault(), void run(locked, password))}>
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Statement password" aria-label="Statement password" />
          <button type="submit" className="primary" disabled={busy || !password}>Open</button>
          <button type="button" onClick={() => setLocked(null)}>Cancel</button>
        </form>
      )}
      {!days.length ? (
        <p className="hint">Pick the account statement PDF from the bank (net banking or the app → Statements). Every entry is kept with the balance after it, so you can go back to any day. It stays in the journal's own data, nothing is sent anywhere.</p>
      ) : (
        <>
          <div className={`bank-margin-card${gap < 0 ? " under" : ""}`}>
            <div>
              <strong>{r2(last.close)}</strong>
              <small>
                {gap < 0 ? `⚠ ${r2(-gap)} below your safety margin` : `${r2(gap)} above your safety margin`}
                {gap < 0 && info.since ? ` since ${shortDay(info.since)}` : ""} · {fromMsgs ? `statement to ${shortDay(stTo)} + ${fromMsgs} from your messages, last ${shortDay(last.day)}` : `up to ${shortDay(last.day)}`}
              </small>
              <span className="bank-fill" role="meter" aria-valuemin={0} aria-valuemax={margin * 2} aria-valuenow={last.close} aria-label="Balance against twice the safety margin">
                <i style={{ width: `${fill * 100}%`, background: `linear-gradient(90deg, ${dayTint(todayKey.slice(0, 8) + "01")}, ${dayTint(todayKey)})` }} />
                <b aria-hidden />
              </span>
            </div>
            <label className="bank-margin-edit">
              Safety
              <input inputMode="decimal" value={marginText} onChange={(e) => setMarginText(e.target.value)} onBlur={setNewMargin} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} aria-label="Safety margin ₹" />
            </label>
          </div>
          <HistoryChart days={days} margin={margin} pick={at} onPick={(i) => ((fromChart.current = true), setPick(i))} />
          <div className="bank-scrub">
            <button type="button" aria-label="Day before" disabled={at <= 0} onClick={() => ((fromChart.current = true), setPick(at - 1))}>‹</button>
            <div className={sel.close < margin ? "under" : ""}>
              <strong>{longDay(sel.day)}</strong>
              <small>{r2(sel.open)} → <b>{r2(sel.close)}</b>{sel.out ? ` · out ${r0(sel.out)}` : ""}{sel.in ? ` · in ${r0(sel.in)}` : ""}</small>
            </div>
            <button type="button" aria-label="Day after" disabled={at >= days.length - 1} onClick={() => ((fromChart.current = true), setPick(at + 1))}>›</button>
          </div>
          <dl className="trend-stats finance-stats bank-split">
            <div>
              <dt>Lowest</dt>
              <dd>{info.lowest ? `${r0(info.lowest.amount)}` : "—"}<small>{info.lowest ? ` ${shortDay(info.lowest.day)}` : ""}</small></dd>
            </div>
            <div>
              <dt>Days under safety</dt>
              <dd>{info.underDays} of {days.length}</dd>
            </div>
            <div>
              <dt>Since {shortDay(days[0].day)}</dt>
              <dd>{signed(last.close - days[0].open).replace(/\.\d\d$/, "")}</dd>
            </div>
          </dl>
          <div className="bank-days" ref={listRef}>
            {[...days].reverse().map((d) => (
              <div key={d.day} data-day={d.day} className={`bank-day${d === sel ? " picked" : ""}${d.close < margin ? " under" : ""}`} style={{ borderLeftColor: dayTint(d.day), background: dayTint(d.day, 0.08) }}>
                <button type="button" className="bank-day-head" onClick={() => setPick(days.indexOf(d))} onDoubleClick={() => onOpenDay(d.day)}>
                  <span>{longDay(d.day)}</span>
                  <span className="bank-day-bal">{r2(d.close)}</span>
                </button>
                <ul>
                  {[...d.txns].reverse().map((t) => (
                    <li key={t.order} className={t.amount < 0 ? "debit" : "credit"} title={t.text}>
                      <span className="bt-who">{t.who}</span>
                      <span className="bt-amt">{signed(t.amount)}</span>
                      <span className={`bt-bal${t.balance < margin ? " under" : ""}`}>{r2(t.balance)}</span>
                    </li>
                  ))}
                </ul>
                {d === sel && <button type="button" className="link bank-open-day" onClick={() => onOpenDay(d.day)}>Open this day's note ›</button>}
              </div>
            ))}
            <div className="bank-day opening">
              <div className="bank-day-head"><span>Opening {shortDay(days[0].day)}</span><span className="bank-day-bal">{r2(days[0].open)}</span></div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

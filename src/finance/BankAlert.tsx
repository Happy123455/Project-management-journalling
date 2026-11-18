import { useEffect, useMemo, useState } from "react";
import type { JournalStore } from "../store";
import type { Alarm } from "../lib/reminders";
import { rupees } from "../lib/finance";
import { dayKey } from "../lib/timestamp";
import { balanceDays, forecastMargin, type MarginForecast } from "../lib/bankStatement";
import { bankNow, readMargin } from "./bankStatement";
import { FINANCE_EVENT } from "./capture";

const DISMISS_KEY = "journal.bankAlertHidden";
const MARGIN_EVENT = "journal:bank-margin";
export const announceMargin = () => window.dispatchEvent(new Event(MARGIN_EVENT));

const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function alertText(f: MarginForecast): { title: string; body: string } {
  const m = rupees(f.margin, 0);
  if (f.level === "under") return { title: `🚨 Bank below your ${m} safety margin`, body: `${rupees(f.balance, 2)} now, ${rupees(f.margin - f.balance, 0)} short.${f.perDay ? ` Spending about ${rupees(f.perDay, 0)}/day lately.` : ""}` };
  const when = f.daysLeft !== null && f.crossDay ? ` in about ${f.daysLeft} day${f.daysLeft === 1 ? "" : "s"} (${shortDay(f.crossDay)})` : " soon";
  return { title: `⚠️ Bank heading to your ${m} safety margin`, body: `${rupees(f.balance, 2)} now, only ${rupees(f.balance - f.margin, 0)} above it. At ${rupees(f.perDay, 0)}/day it gets there${when}.` };
}

/** The bank forecast (statement + typed balances) against the safety margin, kept fresh. */
export function useBankForecast(store: JournalStore | null): MarginForecast | null {
  const [f, setF] = useState<MarginForecast | null>(null);
  useEffect(() => {
    if (!store) return;
    let live = true;
    const load = () =>
      void bankNow(store)
        .then(({ saved, balance }) => live && setF(balance === null ? null : forecastMargin(balanceDays(saved), balance, readMargin(), dayKey(new Date()))))
        .catch(() => {});
    load();
    const evs = [FINANCE_EVENT, "journal:synced", MARGIN_EVENT];
    for (const e of evs) window.addEventListener(e, load);
    return () => {
      live = false;
      for (const e of evs) window.removeEventListener(e, load);
    };
  }, [store]);
  return f;
}

/** A notification once a day while the balance is near or under the margin (9 AM, or a minute from now if later). */
export function bankAlarms(f: MarginForecast | null, now = new Date()): Alarm[] {
  if (!f || f.level === "ok") return [];
  const today = dayKey(now);
  const nine = new Date(now);
  nine.setHours(9, 0, 0, 0);
  const at = Math.max(nine.getTime(), now.getTime() + 60_000);
  const t = alertText(f);
  return [{ id: `bank-margin|${today}|${f.level}`, at, title: t.title, body: t.body, day: today }];
}

/** 🚨 The big red banner on top of the journal while the bank is near or under the safety margin. Hidden for the day by ✕. */
export function BankAlert({ forecast, onOpen }: { forecast: MarginForecast | null; onOpen: () => void }) {
  const today = dayKey(new Date());
  const key = forecast ? `${today}|${forecast.level}` : "";
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const text = useMemo(() => (forecast ? alertText(forecast) : null), [forecast]);
  if (!forecast || forecast.level === "ok" || !text || hidden === key) return null;
  return (
    <div className={`bank-alert ${forecast.level}`} role="alert">
      <button type="button" className="bank-alert-main" onClick={onOpen}>
        <strong>{text.title}</strong>
        <span>{text.body}</span>
        <small>Tap to see the balance history ›</small>
      </button>
      <button
        type="button"
        className="bank-alert-x"
        aria-label="Hide for today"
        onClick={() => {
          setHidden(key);
          try {
            localStorage.setItem(DISMISS_KEY, key);
          } catch {
            /* stays hidden until the app restarts */
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}

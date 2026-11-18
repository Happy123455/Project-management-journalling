import { describe as group, expect, it } from "vitest";
import { balanceDays, balanceOn, describe, forecastMargin, marginInfo, mergeStatement, parseStatement, type PdfItem } from "./bankStatement";

// A made-up statement in the Axis layout (columns at the same x as the real PDF).
const row = (page: number, y: number, cells: [number, string][]): PdfItem[] => cells.map(([x, str]) => ({ page, x, y, str }));
const items: PdfItem[] = [
  ...row(1, 604, [[85, "Statement of Axis Account No: 900000000001234 for the period (From: 01-08-2026 To: 31-08-2026)"]]),
  ...row(1, 583, [[40, "Tran Date"], [92, "Chq No"], [203, "Particulars"], [339, "Debit"], [400, "Credit"], [473, "Balance"], [538, "Init."]]),
  ...row(1, 554, [[132, "OPENING BALANCE"], [497, "20000.00"]]),
  ...row(1, 541, [[39, "02-08-2026"], [132, "UPI/P2M/111111111111/TEA STALL/UPI/"], [354, "50.00"], [497, "19950.00"], [537, "1001"]]),
  ...row(1, 528, [[132, "UPI/P2M/222222222222/Book Shop"]]),
  ...row(1, 519, [[39, "02-08-2026"], [132, "/UPI/SOME BANK"], [350, "5000.50"], [497, "14949.50"], [537, "1001"]]),
  ...row(1, 506, [[132, "SELF CASH DEP-"]]),
  ...row(2, 786, [[39, "10-08-2026"], [132, "BNA/RAJKOT"], [408, "1000.00"], [497, "15949.50"], [537, "1001"]]),
  ...row(2, 770, [[132, "TRANSACTION TOTAL"], [350, "5050.50"], [408, "1000.00"]]),
  ...row(2, 760, [[132, "CLOSING BALANCE"], [497, "15949.50"]]),
];

group("bank statement", () => {
  it("reads entries, signs and balances", () => {
    const st = parseStatement(items);
    expect(st.account).toBe("Axis ··1234");
    expect([st.from, st.to, st.opening, st.closing, st.mismatches]).toEqual(["2026-08-01", "2026-08-31", 20000, 15949.5, 0]);
    expect(st.txns.map((t) => [t.day, t.amount, t.balance, t.who])).toEqual([
      ["2026-08-02", -50, 19950, "Tea Stall"],
      ["2026-08-02", -5000.5, 14949.5, "Book Shop"],
      ["2026-08-10", 1000, 15949.5, "Cash deposit"],
    ]);
    expect(st.txns[1].text).toBe("UPI/P2M/222222222222/Book Shop/UPI/SOME BANK");
  });

  it("keeps an entry once when statements overlap", () => {
    const st = parseStatement(items);
    const a = mergeStatement(null, st);
    const b = mergeStatement(a.next, st);
    expect([a.added, b.added, b.next.txns.length, b.next.periods.length]).toEqual([3, 0, 3, 2]);
  });

  it("days, balance on a day, safety margin", () => {
    const days = balanceDays(mergeStatement(null, parseStatement(items)).next);
    expect(days.map((d) => [d.day, d.open, d.close, d.low, d.out, d.in])).toEqual([
      ["2026-08-02", 20000, 14949.5, 14949.5, 5050.5, 0],
      ["2026-08-10", 14949.5, 15949.5, 14949.5, 0, 1000],
    ]);
    expect([balanceOn(days, "2026-08-01"), balanceOn(days, "2026-08-05"), balanceOn(days, "2026-09-01")]).toEqual([null, 14949.5, 15949.5]);
    expect(marginInfo(days, 15000)).toEqual({ underDays: 1, since: null, lowest: { day: "2026-08-02", amount: 14949.5 } });
    expect(marginInfo(days, 16000).since).toBe("2026-08-02");
  });

  it("names", () => {
    expect(describe("UPI/P2M/365419162696/Google Pl/AXISBANK/MandateE//P2V/").who).toBe("Google Play");
    expect(describe("SB:900000000001234:Int.Pd:01-07-2026 to 30-09-2026").who).toBe("Interest");
  });
});

group("safety margin forecast", () => {
  const day = (d: string, open: number, out: number, inn = 0) => ({ day: d, open, close: open - out + inn, low: Math.min(open, open - out), txns: [], in: inn, out });
  it("under, near by pace, ok", () => {
    const days = [day("2026-11-01", 20000, 1400), day("2026-11-10", 18600, 1400)];
    // 2800 out over 14+ days = 200/day (span 18 days → 155.56/day).
    expect(forecastMargin(days, 14000, 15000, "2026-11-18").level).toBe("under");
    const near = forecastMargin(days, 17000, 15000, "2026-11-18");
    expect([near.level, near.daysLeft]).toEqual(["near", 12]);
    expect(forecastMargin(days, 25000, 15000, "2026-11-18").level).toBe("ok");
    expect(forecastMargin([], 15500, 15000, "2026-11-18").level).toBe("near");
  });
});

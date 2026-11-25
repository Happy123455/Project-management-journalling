import { describe, expect, it } from "vitest";
import { balanceDays, dayTint, liveStatement, type SavedStatements } from "./bankStatement";

const saved: SavedStatements = {
  version: 1,
  account: "Axis ··1234",
  periods: [{ from: "2026-11-01", to: "2026-11-18", opening: 1000, closing: 900, importedAt: 0, count: 1 }],
  txns: [{ day: "2026-11-18", order: 0, amount: -100, balance: 900, text: "x", who: "Shop" }],
};
const at = (d: number, h = 10) => new Date(2026, 10, d, h).getTime();

describe("liveStatement", () => {
  it("carries the statement on with a deposit the tracker read", () => {
    const s = liveStatement(saved, [{ direction: "credit", amount: 5000, at: at(25), party: "Self" }], [])!;
    expect(s.txns[s.txns.length - 1]).toMatchObject({ day: "2026-11-25", amount: 5000, balance: 5900 });
    expect(balanceDays(s).slice(-1)[0].close).toBe(5900);
  });
  it("takes the bank's own balance, a typed balance, and skips cash, other accounts and old entries", () => {
    const s = liveStatement(
      saved,
      [
        { direction: "debit", amount: 50, at: at(17) },
        { direction: "debit", amount: 70, at: at(20), method: "cash" },
        { direction: "debit", amount: 80, at: at(21), account: "9999" },
        { direction: "credit", amount: 300, at: at(22), account: "1234", balance: 1250 },
      ],
      [{ account: "Bank", amount: 2000, at: at(23) }],
    )!;
    expect(s.txns.slice(1).map((t) => t.balance)).toEqual([1250, 2000]);
  });
  it("starts from a typed balance when there's no statement", () => {
    const s = liveStatement(null, [{ direction: "credit", amount: 10, at: at(24) }, { direction: "credit", amount: 5, at: at(26) }], [{ account: "Bank", amount: 100, at: at(25) }])!;
    expect(s.txns.map((t) => t.balance)).toEqual([100, 105]);
  });
});

describe("dayTint", () => {
  it("is deep early in the month and light late", () => {
    const l = (d: string) => Number(/(\d+)% \//.exec(dayTint(d))![1]);
    expect(l("2026-11-01")).toBeLessThan(l("2026-11-30"));
  });
});

import { describe, expect, it } from "vitest";
import { bankFromSentence, bankIn, bankLine, bankState, readBankLine } from "./bank";

const p = (text: string, indent = 0) => ({ type: "paragraph", attrs: { indent }, content: [{ type: "text", text }] });

describe("bank balance", () => {
  it("reads [[bank]] boxes and keeps a history per account", () => {
    const d1 = { type: "doc", content: [p("[[bank]]"), p("Bank balance: 45,230", 1), p("HDFC: 12000", 1)] };
    const d2 = { type: "doc", content: [p("[[bank]]"), p("Bank balance: 40000", 1)] };
    const s = bankState([...bankIn(d1, "2026-11-10"), ...bankIn(d2, "2026-11-18")]);
    expect(s.total).toBe(52000);
    expect(s.accounts.find((a) => a.account === "Bank")).toMatchObject({ amount: 40000, change: -5230 });
    expect(s.history[0]).toMatchObject({ account: "Bank", amount: 40000, change: -5230 });
    expect(s.totals.map((t) => t.total)).toEqual([45230, 57230, 52000]);
  });
  it("writes and understands lines and sentences", () => {
    expect(bankLine("Bank", 45230)).toBe("Bank balance: 45230");
    expect(readBankLine("Bank balance: 45230", "2026-11-18")?.account).toBe("Bank");
    expect(bankFromSentence("my bank balance is ₹45,230")).toEqual({ account: "Bank", amount: 45230 });
    expect(bankFromSentence("HDFC balance 12000")).toEqual({ account: "HDFC", amount: 12000 });
    expect(bankFromSentence("haircut 350 from my pocket")).toBeNull();
  });
});
import { pocketFromSentence } from "./pocket";
describe("bank vs pocket", () => {
  it("a bank balance isn't pocket cash", () => {
    expect(pocketFromSentence("bank balance 45230")).toBeNull();
    expect(pocketFromSentence("my bank balance is 45230")).toBeNull();
  });
});

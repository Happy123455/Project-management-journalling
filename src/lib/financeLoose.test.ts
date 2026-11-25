import { describe, expect, it } from "vitest";
import { lastPaidTo, orderPaid, parseOrder, readLooseLine, txnsIn } from "./finance";

const box = (lines: string[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "[[Finance]]" }] }, ...lines.map((t) => ({ type: "paragraph", attrs: { indent: 1 }, content: [{ type: "text", text: t }] })), { type: "paragraph", content: [{ type: "text", text: "689.85 is not money out here" }] }],
});

describe("money typed by hand (25 Nov: 689.85 under Finance never showed)", () => {
  it("reads a bare amount and words inside the Finance box only", () => {
    const t = txnsIn(box(["689.85", "paid 120 for chai #food", "+5000 salary", "got 200 from mom"]), "2026-11-25");
    expect(t.map((x) => [x.direction, x.amount, x.party ?? ""])).toEqual([
      ["debit", 689.85, ""],
      ["debit", 120, "chai"],
      ["credit", 5000, "salary"],
      ["credit", 200, "mom"],
    ]);
    expect(t[1].category).toBe("food");
  });
  it("leaves words without an amount", () => {
    expect(readLooseLine("ate pizza", "2026-11-25")).toBeNull();
    expect(readLooseLine("689.85 La Pinoz", "2026-11-25")?.party).toBe("La Pinoz");
  });
});

describe("orders with no payment seen", () => {
  const at = Date.parse("2026-11-25T20:00:00+05:30");
  it("reads La Pinoz's SMS and app notifications", () => {
    expect(parseOrder("Dear Customer Online Order ID 50379213 has been received. Outlet will ACCEPT/REJECT the order very soon Thanks Lapinoz Powered By Uengage", at, "VM-UENGAG-S")).toEqual({ merchant: "La Pinoz", orderId: "50379213", at });
    expect(parseOrder("Order Accepted. Order ID #50379213 is Accepted", at, "com.app.uengage.lapinoz")?.orderId).toBe("50379213");
    expect(parseOrder("Free Pizza Alert! La Pino'z: Buy 1 Get 1 offer", at, "JX-LAPINO-P")).toBeNull();
  });
  it("matches a payment near it, and guesses last time's amount", () => {
    const o = { merchant: "La Pinoz", orderId: "50379213", at };
    const old = { direction: "debit" as const, amount: 689.85, party: "La Pinoz Pizza", category: "food", at: at - 14 * 86_400_000 };
    expect(orderPaid(o, [old])).toBe(false);
    expect(orderPaid(o, [{ ...old, at: at + 10 * 60_000 }])).toBe(true);
    expect(lastPaidTo("La Pinoz", [old])).toBe(689.85);
  });
});

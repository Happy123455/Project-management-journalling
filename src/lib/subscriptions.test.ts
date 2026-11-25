import { describe, expect, it } from "vitest";
import { findSubscriptions, mergeSubscriptions, monthView } from "./subscriptions";
import type { Txn } from "./finance";

const t = (party: string, amount: number, d: string): Txn => ({ direction: "debit", amount, party, category: "fun", at: new Date(`${d}T10:00:00`).getTime() });

describe("subscriptions", () => {
  const txns = [t("Netflix", 199, "2026-09-05"), t("Netflix", 199, "2026-10-05"), t("Zomato", 300, "2026-10-06"), t("Zomato", 520, "2026-11-06"), t("Netflix", 199, "2026-11-05"), t("Spotify", 119, "2026-11-12")];
  it("finds monthly payments and known names, not food orders", () => {
    expect(findSubscriptions(txns).map((s) => s.name)).toEqual(["Netflix", "Spotify"]);
  });
  it("shows the month: paid and due", () => {
    const subs = mergeSubscriptions([{ id: "m1", name: "Gemini Pro", amount: 1950, day: 28, cycle: "monthly", match: "google" }], findSubscriptions(txns));
    const v = monthView(subs, txns, 2026, 10);
    expect(v.rows.map((r) => [r.sub.name, !!r.paid])).toEqual([["Netflix", true], ["Spotify", true], ["Gemini Pro", false]]);
    expect(v.total).toBe(199 + 119 + 1950);
    expect(v.due).toBe(1950);
  });
});

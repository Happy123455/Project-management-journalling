import { describe, expect, it } from "vitest";
import { alreadyHave, categorize, forecastMonth, monthly, parseMessage, readLine, txnLine, type Txn } from "./finance";

const at = new Date(2026, 10, 4, 13, 2, 11).getTime();

describe("bank and payment messages", () => {
  it("reads common debit alerts", () => {
    expect(parseMessage("Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 04/11/26 Ref 430912345678 Not You? Call 18002586161/SMS BLOCK UPI to 7308080808", at, "VM-HDFCBK")).toMatchObject({
      direction: "debit", amount: 250, party: "SWIGGY", category: "food", bank: "HDFC", account: "1234", method: "UPI", ref: "430912345678",
    });
    expect(parseMessage("Dear UPI user A/C X5678 debited by 1200.0 on date 04Nov26 trf to PGVCL Refno 430998765432. If not u? call 1800111109. -SBI", at, "AX-SBIUPI")).toMatchObject({
      direction: "debit", amount: 1200, party: "PGVCL", category: "bills", bank: "SBI", account: "5678", ref: "430998765432",
    });
    expect(parseMessage("ICICI Bank Acct XX123 debited for Rs 499.00 on 04-Nov-26; AMAZON PAY credited. UPI:430955554444. Call 18002662 for dispute.", at, "JD-ICICIB")).toMatchObject({
      direction: "debit", amount: 499, party: "AMAZON PAY", category: "shopping", bank: "ICICI", ref: "430955554444",
    });
    expect(parseMessage("INR 2,340.50 spent using ICICI Bank Card XX9876 on 04-Nov-26 on BIGBASKET. Avl Limit: INR 1,20,000.00", at, "JM-ICICIT")).toMatchObject({
      direction: "debit", amount: 2340.5, category: "groceries", account: "9876", method: "Card",
    });
  });
  it("reads credits, including Google Pay's 'paid you'", () => {
    expect(parseMessage("Rs.5,000.00 credited to a/c XX1234 on 04-11-26 by a/c linked to VPA ravi.patel@okaxis (UPI Ref No 430911112222).", at, "VM-HDFCBK")).toMatchObject({
      direction: "credit", amount: 5000, party: "ravi.patel@okaxis", category: "income",
    });
    expect(parseMessage("Ravi Patel paid you ₹500.00", at, "com.google.android.apps.nbu.paisa.user", "notification")).toMatchObject({
      direction: "credit", amount: 500, party: "Ravi Patel", bank: "Google Pay", method: "UPI",
    });
    expect(parseMessage("Payment successful ₹120 paid to Chai Point", at, "com.google.android.apps.nbu.paisa.user", "notification")).toMatchObject({
      direction: "debit", amount: 120, party: "Chai Point", category: "food",
    });
  });
  it("ignores OTPs, offers, requests, reminders and failures", () => {
    for (const s of [
      "123456 is your OTP for a transaction of Rs.500 at AMAZON. Do not share.",
      "Get a pre-approved loan of up to Rs 5,00,000! Apply now",
      "Ravi has requested Rs.200 from you on Google Pay",
      "Your credit card bill of Rs 4,500 is due on 10-Nov",
      "Rs 999 will be debited from your account on 05-Nov for Netflix autopay",
      "Your payment of Rs.300 to Zomato has failed. Any amount debited will be refunded.",
    ]) expect(parseMessage(s, at), s).toBeNull();
  });
});

describe("note lines", () => {
  it("writes and reads back the same transaction", () => {
    const t = parseMessage("Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 04/11/26 Ref 430912345678 Not You? SMS BLOCK UPI to 7308080808", at, "VM-HDFCBK")!;
    const line = txnLine(t);
    expect(line).toBe("4,November,2026 Wednesday (13:02:11) 💸 ₹250.00 to SWIGGY #food (HDFC ••1234 · UPI · ref 430912345678)");
    expect(readLine(line, "2026-11-04")).toMatchObject({ direction: "debit", amount: 250, party: "SWIGGY", category: "food", bank: "HDFC", account: "1234", ref: "430912345678", at });
  });
  it("counts a line typed by hand, re-filed by its tag", () => {
    expect(readLine("💸 ₹40 to chai #food", "2026-11-04")).toMatchObject({ amount: 40, party: "chai", category: "food" });
    expect(readLine("💰 ₹1,00,000 from salary", "2026-11-01")).toMatchObject({ direction: "credit", amount: 100000, category: "income" });
    expect(readLine("spent a lot today", "2026-11-04")).toBeNull();
  });
  it("finds the same payment from the SMS and the Google Pay notification once", () => {
    const sms = parseMessage("Sent Rs.120.00 From HDFC Bank A/C *1234 To Chai Point On 04/11/26 Ref 430912345679", at, "VM-HDFCBK")!;
    const note = parseMessage("₹120 paid to Chai Point", at - 60_000, "com.google.android.apps.nbu.paisa.user", "notification")!;
    expect(alreadyHave(note, [sms])).toBe(true);
    const other = parseMessage("Sent Rs.120.00 From HDFC Bank A/C *1234 To Chai Point On 04/11/26 Ref 430912345680", at + 60_000, "VM-HDFCBK")!;
    expect(alreadyHave(other, [sms])).toBe(false);
  });
});

describe("dashboard", () => {
  it("adds up months and categories, and forecasts", () => {
    const now = new Date(2026, 10, 20, 12);
    const txns: Txn[] = [];
    for (let d = 0; d < 60; d++) txns.push({ direction: "debit", amount: 100, category: "food", at: now.getTime() - d * 86_400_000 });
    txns.push({ direction: "credit", amount: 50000, category: "income", at: now.getTime() });
    const months = monthly(txns);
    const nov = months.find((m) => m.month === "2026-11")!;
    expect(nov.spent).toBe(2000);
    expect(nov.received).toBe(50000);
    expect(nov.byCategory.get("food")).toBe(2000);
    const f = forecastMonth(txns, now)!;
    expect(f.soFar).toBe(2000);
    expect(f.projected).toBeCloseTo(3000);
    expect(categorize("ravi.patel@okaxis", "debit")).toBe("transfer");
  });
});

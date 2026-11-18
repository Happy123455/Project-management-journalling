import { describe, expect, it } from "vitest";
import { pocketFromSentence, pocketIn, pocketLine, pocketState, readPocketLine } from "./pocket";

const p = (text: string, indent = 0) => ({ type: "paragraph", attrs: indent ? { indent } : {}, content: text ? [{ type: "text", text }] : [] });

describe("pocket", () => {
  it("reads Hapi's own lines", () => {
    expect(readPocketLine("Hair cut and beard: 350", "2026-11-17")).toMatchObject({ kind: "out", amount: 350, what: "Hair cut and beard", category: "personal" });
    const dosa = readPocketLine("Brought 2 mishor masala dosha (one cheese added), total 400-30 = 370", "2026-11-17");
    expect(dosa).toMatchObject({ kind: "out", amount: 370, category: "food" });
    expect(dosa!.what).toBe("Brought 2 mishor masala dosha (one cheese added)");
    expect(readPocketLine("From ATM: +2000", "2026-11-17")).toMatchObject({ kind: "in", amount: 2000 });
    expect(readPocketLine("Counted pocket: 1240", "2026-11-17")).toMatchObject({ kind: "count", amount: 1240 });
    expect(readPocketLine("just words", "2026-11-17")).toBeNull();
  });

  it("finds the box in a note and works out the balance", () => {
    const doc = { type: "doc", content: [p("morning"), p("[[pocket]] "), p("Counted pocket: 1000", 1), p("Hair cut and beard: 350", 1), p("Chai: 20", 1), p("after box: 99"), p("samosa 30 [[Pocket]]")] };
    const e = pocketIn(doc, "2026-11-17");
    expect(e.map((x) => x.amount)).toEqual([1000, 350, 20, 30]);
    const s = pocketState(e, new Date(2026, 10, 17, 20));
    expect(s.balance).toBe(1000 - 350 - 20 - 30);
    expect(s.spentToday).toBe(400);
  });

  it("understands a spoken spend", () => {
    expect(pocketFromSentence("I had a haircut costing 350 rupees from my pocket")).toEqual({ kind: "out", amount: 350, what: "Haircut" });
    expect(pocketFromSentence("I have spent 370 rupees on buying food from pocket")).toMatchObject({ kind: "out", amount: 370 });
    expect(pocketFromSentence("took 2000 from ATM")).toMatchObject({ kind: "in", amount: 2000 });
    expect(pocketFromSentence("counted my wallet, 1240 left in pocket")).toMatchObject({ kind: "count", amount: 1240 });
    expect(pocketFromSentence("bought chai for 20")).toBeNull();
    expect(pocketLine("out", 350, "Haircut")).toBe("Haircut: 350");
    expect(pocketLine("in", 2000, "From ATM")).toBe("From ATM: +2000");
  });
});

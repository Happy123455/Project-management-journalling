import { describe, expect, it } from "vitest";
import { listedAmounts, pocketStatement, pocketsFromSentence, readPocketLines } from "./pocket";

describe("pocket lists and payees (25 Nov)", () => {
  it("splits listed amounts", () => {
    expect(listedAmounts("Added: +50, +500 and 200")).toEqual([50, 500, 200]);
    expect(listedAmounts("total 400-30 = 370")).toBeNull();
    expect(readPocketLines("Added +50 +500 +200", "2026-11-25").map((e) => e.amount)).toEqual([50, 500, 200]);
    expect(pocketsFromSentence("I added +50, +500 and 200 rupees in my pocket")?.map((e) => [e.kind, e.amount])).toEqual([["in", 50], ["in", 500], ["in", 200]]);
  });
  it("knows a rickshawala is cash", () => {
    expect(pocketsFromSentence("I paid 50 to the rickshawala")).toEqual([{ kind: "out", amount: 50, what: "Rickshawala" }]);
  });
  it("runs the pocket as a statement from the first count", () => {
    const e = readPocketLines("Counted pocket: 1000", "2026-11-24").concat(readPocketLines("Chai: 20", "2026-11-25"));
    expect(pocketStatement(e).map((t) => t.balance)).toEqual([1000, 980]);
  });
});

import { describe, expect, test } from "vitest";
import { mathBlocksIn, workOut } from "./mathFind";
import { evaluate } from "./mathEval";
import { displayLatex } from "./mathSmart";

const answer = (latex: string) => mathBlocksIn({ type: "doc", content: [{ type: "mathBlock", attrs: { latex } }] }, "x")[0]?.answer;

describe("averages and lists in math blocks (18 Nov: the agent couldn't make an averaging block)", () => {
  test("avg / average / mean / sum / min / max / median / count", () => {
    expect(evaluate("avg(80, 90, 70)")).toBe(80);
    expect(evaluate("average(12,15,18)")).toBe(15);
    expect(evaluate("mean(1, 2, 3, 4)")).toBe(2.5);
    expect(evaluate("sum(100,200,300)")).toBe(600);
    expect(evaluate("max(3, 9, 4) - min(3, 9, 4)")).toBe(6);
    expect(evaluate("median(5, 1, 9, 3)")).toBe(4);
    expect(evaluate("count(5, 1, 9)")).toBe(3);
    // Outside a list function a comma is still a thousands separator.
    expect(evaluate("1,000 + 1")).toBe(1001);
  });
  test("blocks the agent writes", () => {
    expect(answer("mean = avg(80,90,70)")).toBe("mean = 80");
    expect(answer("scores = 80, 90, 70\naverage = avg(scores)")).toBe("average = 80");
    expect(answer("scores = 80, 90, 70\naverage = sum(scores)/count(scores)")).toBe("average = 80");
    expect(answer("total = 80 + 90 + 70\ncount = 3\naverage = total / count")).toBe("average = 80");
    expect(answer("price = 1,200\nn = 2\nper = price/n")).toBe("per = 600");
  });
  test("working and drawing", () => {
    const w = workOut(["scores = 80, 90, 70"], "average = avg(scores)");
    expect(w.answer).toBe("average = 80");
    expect(w.steps.join(" | ")).toContain("avg(80, 90, 70)");
    expect(displayLatex("avg(80, 90, 70)")).toContain("\\operatorname{avg}");
  });
});

import { describe, expect, it } from "vitest";
import { answerFor, evaluate, formatAnswer } from "./mathEval";

describe("auto math", () => {
  it("solves sums typed before =", () => {
    expect(answerFor("12+12")).toBe("24");
    expect(answerFor("12 + 12 ")).toBe("24");
    expect(answerFor("Spent 250*3")).toBe("750");
    expect(answerFor("(2+3)×4")).toBe("20");
    expect(answerFor("10÷4")).toBe("2.5");
    expect(answerFor("2^10")).toBe("1024");
    expect(answerFor("1,200 - 200")).toBe("1000");
    expect(answerFor("0.1+0.2")).toBe("0.3");
    expect(answerFor("200*15%")).toBe("30");
    expect(answerFor("3x4")).toBe("12");
    expect(answerFor("box 2+2")).toBe("4");
  });
  it("leaves everything else alone", () => {
    expect(answerFor("2026")).toBeNull();
    expect(answerFor("x")).toBeNull();
    expect(answerFor("a = b")).toBeNull();
    expect(answerFor("v1+2")).toBeNull();
    expect(answerFor("(5)")).toBeNull();
    expect(answerFor("1/0")).toBeNull();
    expect(answerFor("2+")).toBeNull();
    expect(answerFor("")).toBeNull();
  });
  it("evaluates with the usual order", () => {
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("2^3^2")).toBe(512);
    expect(formatAnswer(1 / 3)).toBe("0.3333333333");
  });
});

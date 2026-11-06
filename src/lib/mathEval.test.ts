import { describe, expect, it } from "vitest";
import { answerFor, evaluate, formatAnswer, definitionsIn, conflictsIn, namesIn } from "./mathEval";

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

import { variablesIn } from "./mathEval";

describe("variables, like Math Notes", () => {
  const vars = variablesIn(["x = 5", "rate = 12/60", "total = x * rate", "y = x*2 =10", "a = b", "note: nothing here"]);
  it("defines names from lines above, each using the ones before", () => {
    expect([...vars]).toEqual([["x", 5], ["rate", 0.2], ["total", 1], ["y", 10]]);
  });
  it("uses them, with functions and side-by-side times", () => {
    expect(answerFor("2x + 1", vars)).toBe("11");
    expect(answerFor("total cost x*rate*100", vars)).toBe("100");
    expect(answerFor("sqrt(x*5)", vars)).toBe("5");
    expect(answerFor("y", vars)).toBeNull(); // "y =" starts a new definition
    expect(answerFor("so y", vars)).toBe("10");
    expect(answerFor("2 pi", vars)).toBe("6.2831853072");
    expect(answerFor("z + 1", vars)).toBe(null);
    expect(answerFor("3x4", new Map([["y", 1]]))).toBe("12");
  });
});

describe("variables written in sentences", () => {
  it("reads a name in brackets before or inside the definition", () => {
    const defs = definitionsIn(["this is a friction coefficient(F)=1.2", "and the normal force (N = 50 newton)"]);
    expect(defs).toEqual([
      { name: "F", value: 1.2, line: 0, label: "friction coefficient" },
      { name: "N", value: 50, line: 1, label: "normal force" },
    ]);
    expect(definitionsIn(["this is a friction coefficient(F=1.2)"])[0]).toMatchObject({ name: "F", value: 1.2 });
  });
  it("reads 'the mass m = 5 kg' but not a long word in a sentence", () => {
    expect(definitionsIn(["the mass m = 5 kg"])).toEqual([{ name: "m", value: 5, line: 0, label: "mass" }]);
    expect(definitionsIn(["so the total = 5"])).toEqual([]);
  });
  it("uses earlier variables and the written answer", () => {
    const v = variablesIn(["m = 5", "g = 9.8", "weight W = m*g", "y = m*2 = 10"]);
    expect(v.get("W")).toBeCloseTo(49);
    expect(v.get("y")).toBe(10);
  });
  it("warns when one name gets different values", () => {
    const c = conflictsIn(definitionsIn(["F = 1.2", "x = 3", "coefficient(F)=1.5", "x = 3"]));
    expect([...c.keys()]).toEqual(["F"]);
    expect(c.get("F")!.map((d) => d.value)).toEqual([1.2, 1.5]);
  });
  it("lists the names an expression uses", () => {
    expect(namesIn("2x + sqrt(m*g) - pi")).toEqual(["x", "m", "g"]);
  });
});

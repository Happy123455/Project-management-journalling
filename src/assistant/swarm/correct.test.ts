import { describe, expect, it } from "vitest";
import { changesOf, diffOps, explain, likeness, summary, tokens } from "./correct";
import { navRoute } from "./navShow";

describe("word-by-word corrections", () => {
  it("splits words, marks and their spaces", () => {
    expect(tokens("Hi, you  there.").map((t) => t.w + "|" + t.sp)).toEqual(["Hi|", ",| ", "you|  ", "there|", ".|"]);
  });

  it("finds inserts, deletes and replacements, word by word", () => {
    const ops = diffOps("i recieve teh the letter yesterday", "I received the letter, yesterday");
    const kinds = ops.filter((o) => o.kind !== "same").map((o) => `${o.kind}:${o.a.map((t) => t.w).join(" ")}>${o.b.map((t) => t.w).join(" ")}`);
    expect(kinds).toContain("ins:>,");
    expect(kinds.some((k) => k.startsWith("rep:i>I"))).toBe(true);
    // The rebuilt new side reads as the new text.
    expect(ops.map((o) => o.b.map((t) => t.w + t.sp).join("")).join("")).toBe("I received the letter, yesterday");
  });

  it("explains each kind of fix", () => {
    const one = (a: string, b: string) => explain(diffOps(a, b).find((o) => o.kind !== "same")!).label;
    expect(one("hello world", "Hello world")).toBe("Capital letter");
    expect(one("I recieve it", "I receive it")).toBe("Spelling");
    expect(one("she walk home", "she walked home")).toBe("Word form");
    expect(one("go home now", "go home, now")).toBe("Punctuation");
    expect(one("I want go", "I want to go")).toBe("Missing word");
    expect(one("it is is fine", "it is fine")).toBe("Removed");
    expect(one("a big house", "a huge house")).toBe("Better word");
  });

  it("sums the changes up", () => {
    const c = changesOf(diffOps("i recieve it", "I receive it."));
    expect(c.length).toBe(3);
    expect(summary(c)).toMatch(/^3 changes: /);
  });

  it("tells a reworded paragraph from a different one", () => {
    expect(likeness("I went to the market today", "I went to the market today.")).toBeGreaterThan(0.8);
    expect(likeness("Buy milk", "Call the dentist about Tuesday")).toBe(0);
  });
});

describe("agent navigation route", () => {
  it("goes through Home, the week, the month or the year", () => {
    expect(navRoute("2026-11-18", "2026-11-18", "2026-11", true)).toBe("home");
    expect(navRoute("2026-11-16", "2026-11-18", "2026-11", true)).toBe("week");
    expect(navRoute("2026-10-02", "2026-11-18", "2026-11", false)).toBe("month");
    expect(navRoute("2026-09-20", "2026-11-18", "2026-11", false)).toBe("month");
    expect(navRoute("2026-06-01", "2026-11-18", "2026-11", false)).toBe("year");
    expect(navRoute("2024-02-01", "2026-11-18", "2026-11", false)).toBe("year");
  });
});

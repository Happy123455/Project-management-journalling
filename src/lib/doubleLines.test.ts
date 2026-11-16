import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/react";
import { findDoubles, withoutLine } from "./doubleLines";

const p = (lid: string, text: string): JSONContent => ({ type: "paragraph", attrs: { lid }, content: text ? [{ type: "text", text }] : undefined });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

describe("possible double lines", () => {
  it("finds the cases from Hapi's notes", () => {
    const jensen = "The news is comform 13,November,2026 Friday (13:59:15) Jensen Huang is resigning from ceo";
    const found = findDoubles(
      "2026-11-13",
      doc(
        p("r0", jensen),
        p("r1", ""),
        p("r0~Phone", jensen),
        p("r2", "Compacted coming up section acording to ui stand point there edges isn"),
        p("r3", "Compacted coming up section acording to ui stand point there edges isn't right, fix it"),
        p("r4", "🎲 How did it go? Pause all new feature requests [[Journal]]"),
        p("r5", "🎲 How did it go? Pause all new feature requests [[Journal]]"),
      ),
    );
    expect(found.map((d) => [d.lid, d.twinLid, d.why])).toEqual([
      ["r0~Phone", "r0", "clash-copy"],
      ["r2", "r3", "half"],
      ["r5", "r4", "copy"],
    ]);
  });

  it("leaves short repeats, far lines and different lines alone", () => {
    const found = findDoubles("d", doc(p("a", "[[Journal]]"), p("b", "[[Journal]]"), p("c", "Long enough line about the journal"), p("d", "x"), p("e", "y"), p("f", "z"), p("g", "Long enough line about the journal")));
    expect(found).toEqual([]);
  });

  it("removes only the named line, and only while it still has that text", () => {
    const d = doc(p("a", "one two three four five six"), p("b", "one two three"));
    expect(withoutLine(d, { lid: "b", text: "one two three" })?.content).toHaveLength(1);
    expect(withoutLine(d, { lid: "b", text: "something else" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { findMatches } from "./findHighlight";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    chip: { group: "inline", inline: true, atom: true },
  },
});

describe("findMatches", () => {
  it("finds every match with document positions, also after inline media", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("met Ravi")]),
      schema.node("paragraph", null, [schema.node("chip"), schema.text(" ravi again")]),
    ]);
    const matches = findMatches(doc, ["ravi"]);
    expect(matches.map((m) => doc.textBetween(m.from, m.to))).toEqual(["Ravi", "ravi"]);
    expect(findMatches(doc, [])).toEqual([]);
  });
});

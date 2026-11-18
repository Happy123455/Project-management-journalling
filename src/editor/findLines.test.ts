import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node as PMNode } from "@tiptap/pm/model";
import { findMatches, matchLines } from "./findHighlight";

describe("search in this note", () => {
  it("lists matching lines numbered like the note's highlights", () => {
    const schema = getSchema([StarterKit]);
    const doc = PMNode.fromJSON(schema, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "apple pie and apple tart" }] },
        { type: "paragraph", content: [{ type: "text", text: "nothing here" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Apple notes" }] },
      ],
    });
    const { lines, total } = matchLines(doc, ["apple"]);
    expect(total).toBe(findMatches(doc, ["apple"]).length);
    expect(total).toBe(3);
    expect(lines.map((l) => l.first)).toEqual([0, 2]);
    expect(lines[1].text).toBe("Apple notes");
  });
});

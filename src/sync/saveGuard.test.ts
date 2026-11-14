import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/react";
import { editorSaw, guardSave } from "./saveGuard";

const p = (lid: string, text: string): JSONContent => ({ type: "paragraph", attrs: { lid }, content: [{ type: "text", text }] });
const doc = (...c: JSONContent[]): JSONContent => ({ type: "doc", content: c });

describe("a save from a behind editor", () => {
  it("keeps a line sync added that the editor never showed (8 Nov 'next front')", () => {
    editorSaw("day:a", doc(p("a", "one")));
    // The Mac's line arrives in the store; the phone's editor doesn't have it and the phone types.
    const stored = doc(p("a", "one"), p("m", "next front"));
    const saved = guardSave("day:a", doc(p("a", "one!")), stored);
    expect(saved).toEqual(doc(p("a", "one!"), p("m", "next front")));
  });
  it("still deletes a line the editor had and the person removed", () => {
    editorSaw("day:b", doc(p("a", "one"), p("b", "two")));
    expect(guardSave("day:b", doc(p("a", "one")), doc(p("a", "one"), p("b", "two")))).toEqual(doc(p("a", "one")));
    // And after a guarded save the editor's own note is the new starting point.
    expect(guardSave("day:b", doc(p("a", "one"), p("c", "x")), doc(p("a", "one")))).toEqual(doc(p("a", "one"), p("c", "x")));
  });
});

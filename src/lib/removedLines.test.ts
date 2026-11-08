import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/react";
import type { JournalEvent } from "../store/types";
import { putBack, removedLines } from "./removedLines";

const p = (lid: string, text: string): JSONContent => ({ type: "paragraph", attrs: { lid }, content: [{ type: "text", text }] });
const doc = (...c: JSONContent[]): JSONContent => ({ type: "doc", content: c });
const ev = (n: number, before: JSONContent | null, after: JSONContent, deviceId = "phone", actor = "me"): JournalEvent =>
  ({ id: `e${n}`, deviceId, actor, blockId: "b", op: before ? "update" : "create", before: before && JSON.stringify(before), after: JSON.stringify(after), parentEventIds: [], createdAt: `2026-11-08T10:0${n}:00Z` }) as JournalEvent;

describe("lines taken out of a note", () => {
  const v1 = doc(p("a", "first"), p("b", "phone thought"), p("c", "last"));
  const v2 = doc(p("a", "first"), p("c", "last"));
  it("lists a line an edit removed, and puts it back in its place", () => {
    const events = [ev(1, null, v1), ev(2, v1, v2, "mac", "sync")];
    const gone = removedLines(events, v2);
    expect(gone.map((g) => [g.text, g.deviceId, g.actor])).toEqual([["phone thought", "mac", "sync"]]);
    expect(putBack(v2, gone[0])).toEqual(v1);
  });
  it("skips lines that are still there (moved, or same text under another id) and blank lines", () => {
    const moved = doc(p("c", "last"), p("x", "phone thought"), p("a", "first"));
    expect(removedLines([ev(1, null, v1), ev(2, v1, v2)], moved)).toEqual([]);
    const blank = doc(p("a", "first"), { type: "paragraph", attrs: { lid: "z" } });
    expect(removedLines([ev(1, blank, doc(p("a", "first")))], doc(p("a", "first")))).toEqual([]);
  });
});

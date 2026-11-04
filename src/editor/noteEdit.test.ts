import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { Blocks } from "./blocks";
import { editLineJSON, editLinePM, insertLogLinePM } from "./noteEdit";
import { timeEdit, DONE_MARK } from "../lib/reminders";

const schema = getSchema([StarterKit, Blocks]);
const p = (text: string, indent = 0) => ({ type: "paragraph", attrs: { indent }, content: text ? [{ type: "text", text }] : [] });

/** Enough of an editor for the helpers: its state, schema and a dispatch that applies. */
function fake(content: unknown[]) {
  const e = { schema, state: EditorState.create({ doc: schema.nodeFromJSON({ type: "doc", content }) }) } as unknown as { state: EditorState; view: { dispatch: (tr: unknown) => void } };
  e.view = { dispatch: (tr) => (e.state = e.state.apply(tr as never)) };
  return e as unknown as Editor & { state: EditorState };
}
const lines = (e: { state: EditorState }) => e.state.doc.content.content.map((n) => [n.textContent, n.attrs.indent]);

describe("changing a line from outside the editor", () => {
  it("JSON: moves a time, keeping bold pieces", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "dentist " }, { type: "text", text: "15:30", marks: [{ type: "bold" }] }, { type: "text", text: " ok" }] }] };
    const out = editLineJSON(doc, "dentist 15:30 ok", timeEdit("dentist 15:30 ok", 16, 0))!;
    expect(out.content![0].content).toEqual([{ type: "text", text: "dentist " }, { type: "text", text: "16:00", marks: [{ type: "bold" }] }, { type: "text", text: " ok" }]);
    expect(editLineJSON(doc, "nope", { index: 0, del: 0, ins: "x" })).toBeNull();
    const done = editLineJSON(doc, "dentist 15:30 ok", { index: 0, del: 0, ins: DONE_MARK })!;
    expect(done.content![0].content!.map((c) => c.text).join("")).toBe("✅ dentist 15:30 ok");
  });

  it("PM: ticks off and re-times a line", () => {
    const e = fake([p("hello"), p("⏰ 15:30 call")]);
    expect(editLinePM(e, "⏰ 15:30 call", timeEdit("⏰ 15:30 call", 9, 5))).toBe(true);
    expect(editLinePM(e, "⏰ 09:05 call", { index: 0, del: 0, ins: DONE_MARK })).toBe(true);
    expect(lines(e)).toEqual([["hello", 0], ["✅ ⏰ 09:05 call", 0]]);
  });

  it("PM: log lines go to the end of the Routine box", () => {
    const e = fake([p("hello"), p("")]);
    insertLogLinePM(e, "A");
    expect(lines(e)).toEqual([["hello", 0], ["[[Routine]]", 0], ["A", 1]]);
    const f = fake([p("[[Routine]]"), p("A", 1), p("later")]);
    insertLogLinePM(f, "B");
    expect(lines(f)).toEqual([["[[Routine]]", 0], ["A", 1], ["B", 1], ["later", 0]]);
  });
});

import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { liftListItem, wrapInList } from "@tiptap/pm/schema-list";
import { Blocks, blockText, listKeepsIndent } from "./blocks";
import { mathFollowUp } from "./mathAuto";
import { stampsIn, formatGap, railPlaces, timestampTime } from "../lib/timeGaps";

const schema = getSchema([StarterKit, Blocks]);
const doc = (content: unknown[]) => schema.nodeFromJSON({ type: "doc", content });
const p = (text: string, indent = 0) => ({ type: "paragraph", attrs: { indent }, content: text ? [{ type: "text", text }] : [] });

/** Runs a command, then the list-indent follow-up like the plugin does. */
function run(state: EditorState, cmd: (s: EditorState, d: (tr: import("@tiptap/pm/state").Transaction) => void) => boolean) {
  let out = state;
  cmd(state, (tr) => {
    const after = state.apply(tr);
    const extra = listKeepsIndent(after, state, [tr]);
    out = extra ? after.apply(extra) : after;
  });
  return out;
}

describe("lists keep the nesting of the line they came from", () => {
  it("a bullet made in a box stays in the box, and comes back out nested", () => {
    let s = EditorState.create({ schema, doc: doc([p("[[Project]]"), p("first", 1), p("second", 1)]) });
    // Cursor in "second".
    const at = s.doc.child(0).nodeSize + s.doc.child(1).nodeSize + 2;
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, at)));
    s = run(s, wrapInList(schema.nodes.bulletList));
    const list = s.doc.child(2);
    expect(list.type.name).toBe("bulletList");
    expect(list.attrs.indent).toBe(1);
    expect(list.firstChild!.firstChild!.attrs.indent).toBe(0);
    // Un-bullet: the line goes back to indent 1, still in the box.
    s = run(s, liftListItem(schema.nodes.listItem));
    expect(s.doc.child(2).type.name).toBe("paragraph");
    expect(s.doc.child(2).attrs.indent).toBe(1);
  });
});

describe("copying a block", () => {
  it("copies the block and what's nested in it, nesting relative to the block", () => {
    const d = doc([p("before"), p("[[Gym]]", 1), p("squats", 2), p("run", 3), p("after", 1)]);
    expect(blockText(d, 1)).toBe("[[Gym]]\n\tsquats\n\t\trun");
  });
});

describe("auto math in the editor", () => {
  it("writes the answer after =, cursor after it", () => {
    const s0 = EditorState.create({ schema, doc: doc([p("12+12")]) });
    const s = s0.apply(s0.tr.setSelection(TextSelection.create(s0.doc, 6)));
    const tr = s.tr.insertText("=", 6);
    const after = s.apply(tr);
    const extra = mathFollowUp(tr, after, true)!;
    const done = after.apply(extra);
    expect(done.doc.textContent).toBe("12+12=24");
    expect(done.selection.from).toBe(9);
    expect(mathFollowUp(tr, after, false)).toBeNull();
  });
});

describe("time between timestamps", () => {
  it("reads timestamps, the text after them, and the gaps", () => {
    const stamps = stampsIn([
      { pos: 1, text: "3,November,2026 Tuesday (09:00:00) woke up" },
      { pos: 50, text: "3,November,2026 Tuesday (10:30:00) gym 3,November,2026 Tuesday (12:00:00) lunch" },
    ]);
    expect(stamps.map((s) => s.label)).toEqual(["woke up", "gym", "lunch"]);
    expect(stamps[1].pos).toBe(50);
    expect(formatGap(stamps[1].time - stamps[0].time)).toBe("1h 30m");
    expect(railPlaces(stamps)).toEqual([0, 0.5, 1]);
    expect(formatGap(45_000)).toBe("45s");
    expect(formatGap(26 * 3600_000)).toBe("1d 2h");
    expect(timestampTime("27,October,2026 Tuesday (22:04:26)")).toBe(new Date(2026, 9, 27, 22, 4, 26).getTime());
  });
});

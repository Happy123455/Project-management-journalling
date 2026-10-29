import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { pairFollowUp } from "./autoPairs";

const schema = getSchema([StarterKit]);
const start = (text: string, at = text.length) => {
  const s = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] }) });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1 + at)));
};
/** Types (or with "⌫" deletes before the cursor) like a keyboard, then applies the follow-up. */
function key(s: EditorState, ch: string) {
  const at = s.selection.from;
  const tr = ch === "⌫" ? s.tr.delete(at - 1, at) : s.tr.insertText(ch, at);
  const after = s.apply(tr);
  const extra = pairFollowUp(tr, s, after);
  return extra ? after.apply(extra) : after;
}
const show = (s: EditorState) => {
  const t = s.doc.textContent;
  const at = s.selection.from - 1;
  return t.slice(0, at) + "|" + t.slice(at);
};

describe("auto pairs", () => {
  it("closes [ ( { \" ` and types over the closer", () => {
    let s = key(start(""), "[");
    expect(show(s)).toBe("[|]");
    s = key(s, "[");
    expect(show(s)).toBe("[[|]]");
    s = key(key(key(s, "A"), "]"), "]");
    expect(show(s)).toBe("[[A]]|");
    expect(show(key(start("f"), "("))).toBe("f(|)");
  });

  it("leaves apostrophes inside words alone", () => {
    expect(show(key(start("don"), "'"))).toBe("don'|");
    expect(show(key(start("say "), "'"))).toBe("say '|'");
  });

  it("Backspace on an empty pair removes both", () => {
    const s = key(start(""), "(");
    expect(show(key(s, "⌫"))).toBe("|");
  });
});

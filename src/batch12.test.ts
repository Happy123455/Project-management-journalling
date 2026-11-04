import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Blocks, blockPlainText } from "./editor/blocks";
import { pairFollowUp } from "./editor/autoPairs";
import { BlockBorn } from "./editor/blockBorn";
import { linkOptions, tagOptions } from "./editor/linkSuggest";
import { dayOptions, headingsIn, isNoteEmbed, sectionOf, splitTarget, targetLabel } from "./lib/noteLinks";
import { extractLinks } from "./lib/links";
import { docLines, docMatches, parseQuery, searchTerms } from "./lib/search";
import { plainText } from "./lib/plainText";
import { readLine, rewriteLine } from "./lib/finance";
import { MemoryStore } from "./store/memoryStore";
import { textKey } from "./sync/clipboard";
import { entryTime } from "./projects/ProjectTimeline";

const p = (text: string, indent = 0) => ({ type: "paragraph", attrs: { indent }, content: text ? [{ type: "text", text }] : [] });
const h = (text: string, level = 2) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });

describe("links and embeds between notes", () => {
  it("splits a target into the note and its part", () => {
    expect(splitTarget("2026-11-03#Plans")).toEqual({ note: "2026-11-03", section: "Plans" });
    expect(splitTarget("Ravi")).toEqual({ note: "Ravi", section: null });
    // A page called C# stays itself.
    expect(splitTarget("C#")).toEqual({ note: "C#", section: null });
    expect(targetLabel("2026-11-03#Plans")).toMatch(/3.*Nov.*› Plans/);
  });

  it("tells note embeds from media embeds", () => {
    expect(isNoteEmbed("2026-11-03")).toBe(true);
    expect(isNoteEmbed("Ravi#Plans")).toBe(true);
    expect(isNoteEmbed("attachments/abc/photo.png")).toBe(false);
    expect(isNoteEmbed("photo.png")).toBe(false);
  });

  it("a backlink of a part is a backlink of the whole note", () => {
    expect(extractLinks("see [[2026-11-03#Plans]] and [[Ravi|him]] and [[C#]]").wikilinks).toEqual(["2026-11-03", "Ravi", "C#"]);
  });

  it("finds a section: the heading and what's under it, up to the next heading of its level", () => {
    const doc = { type: "doc", content: [p("intro"), h("Plans"), p("gym"), h("Detail", 3), p("squats"), h("Food"), p("rice")] };
    expect(headingsIn(doc)).toEqual(["Plans", "Detail", "Food"]);
    expect(sectionOf(doc, "plans")!.map((b) => b.content?.[0]?.text)).toEqual(["Plans", "gym", "Detail", "squats"]);
    expect(sectionOf(doc, "Food")!.map((b) => b.content?.[0]?.text)).toEqual(["Food", "rice"]);
    // No heading: the line that starts with it, and what's indented under it.
    const doc2 = { type: "doc", content: [p("Meeting notes"), p("point", 1), p("other")] };
    expect(sectionOf(doc2, "meeting")!.length).toBe(2);
    expect(sectionOf(doc2, "nothing here")).toBeNull();
  });

  it("suggests days by date words", () => {
    const today = "2026-11-04";
    expect(dayOptions([], "", today).map((d) => d.day)).toEqual(["2026-11-04", "2026-11-03", "2026-11-05"]);
    expect(dayOptions(["2026-10-01", "2026-11-02"], "yest", today).map((d) => d.day)).toEqual(["2026-11-03"]);
    expect(dayOptions(["2026-10-01", "2026-11-02"], "2026-10", today).map((d) => d.day)).toEqual(["2026-10-01"]);
  });

  it("keeps the [[ page suggestions working", () => {
    expect(linkOptions(["Ravi", "Project Ravi"], "rav").map((o) => o.name)).toEqual(["Ravi", "Project Ravi", "rav"]);
  });
});

describe("#tag suggestions", () => {
  it("offers existing tags starting with what's typed first, without the exact one", () => {
    expect(tagOptions(["food", "fun", "travel", "foodie"], "fo")).toEqual(["food", "foodie"]);
    expect(tagOptions(["food", "seafood"], "food")).toEqual(["seafood"]);
    expect(tagOptions(["a", "b"], "")).toEqual(["a", "b"]);
  });
});

describe("search: line:( ) and section:( )", () => {
  it("reads groups out of the search", () => {
    expect(parseQuery("line:(alphabet Microsoft) cloud")).toEqual({ terms: ["cloud"], groups: [{ scope: "line", terms: ["alphabet", "microsoft"] }] });
    expect(parseQuery('section:("big tech" ai)').groups).toEqual([{ scope: "section", terms: ["big tech", "ai"] }]);
    expect(searchTerms("line:(alphabet Microsoft) cloud")).toEqual(["cloud", "alphabet", "microsoft"]);
  });

  const doc = {
    type: "doc",
    content: [p("Alphabet earnings today"), p("Microsoft too"), h("Big tech"), p("alphabet and microsoft both up"), h("Other"), p("nothing")],
  };
  it("line: needs the words on one line", () => {
    expect(docMatches(doc, "line:(alphabet microsoft)")).toBe(true);
    const apart = { type: "doc", content: [p("Alphabet earnings"), p("Microsoft too")] };
    expect(docMatches(apart, "line:(alphabet microsoft)")).toBe(false);
    expect(docMatches(apart, "alphabet microsoft")).toBe(true);
  });

  it("section: needs them under one heading", () => {
    const split = { type: "doc", content: [h("A"), p("alphabet"), h("B"), p("microsoft")] };
    expect(docMatches(split, "section:(alphabet microsoft)")).toBe(false);
    const together = { type: "doc", content: [h("A"), p("alphabet"), p("then microsoft"), h("B"), p("x")] };
    expect(docMatches(together, "section:(alphabet microsoft)")).toBe(true);
  });

  it("formatted text is still one line", () => {
    const bold = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Alphabet " }, { type: "text", text: "Microsoft", marks: [{ type: "bold" }] }] }] };
    expect(docLines(bold)).toEqual([{ text: "Alphabet Microsoft", section: 0, block: 0 }]);
    expect(docMatches(bold, "line:(alphabet microsoft)")).toBe(true);
  });

  it("the store's search uses them", async () => {
    const store = new MemoryStore(undefined, "phone");
    await store.saveDay({ day: "2026-11-01", content: { type: "doc", content: [p("Alphabet and Microsoft")] }, plainText: "Alphabet and Microsoft" });
    await store.saveDay({ day: "2026-11-02", content: { type: "doc", content: [p("Alphabet"), p("Microsoft")] }, plainText: "Alphabet\nMicrosoft" });
    const hits = await store.search("line:(alphabet microsoft)");
    expect(hits.map((x) => (x.kind === "day" ? x.day : null))).toEqual(["2026-11-01"]);
    expect((await store.search("alphabet microsoft")).length).toBe(2);
  });
});

describe("copying as plain text", () => {
  it("drops the box's [[title]] line and markup, no <br/>", () => {
    const blocks = [p("[[Gym]]"), p("squats 3x10", 1), p("", 1), p("", 1), p("run [[Park|the park]]", 2), p("", 1)];
    expect(plainText(blocks, { dropBoxTitle: true })).toBe("squats 3x10\n\n  run the park");
  });

  it("keeps a title line that says more than the link", () => {
    expect(plainText([p("Met [[Ravi]] about it"), p("ok", 1)], { dropBoxTitle: true })).toBe("Met Ravi about it\n  ok");
  });

  it("lists and tasks get markers", () => {
    const list = {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [p("done")] },
        { type: "taskItem", attrs: { checked: false }, content: [p("todo")] },
      ],
    };
    expect(plainText([list as never])).toBe("☑ done\n☐ todo");
  });

  it("the block ⧉ copies plain text", () => {
    const schema = getSchema([StarterKit, Blocks]);
    const d = schema.nodeFromJSON({ type: "doc", content: [p("before"), p("[[Gym]]", 1), p("squats", 2), p("", 2), p("after", 1)] });
    expect(blockPlainText(d, 1)).toBe("squats");
  });
});

describe("editing a payment", () => {
  const line = "4,November,2026 Wednesday (13:02:11) 💸 ₹250.00 to Swiggy #food (HDFC ••1234 · UPI · ref 430912345678)";
  it("rewrites the amount, who, category and time; keeps the bank details", () => {
    const next = rewriteLine(line, "2026-11-04", { amount: 300, party: "Zomato", category: "Food Out", time: "14:30" })!;
    expect(next).toBe("4,November,2026 Wednesday (14:30:11) 💸 ₹300.00 to Zomato #food-out (HDFC ••1234 · UPI · ref 430912345678)");
    const t = readLine(next, "2026-11-04")!;
    expect(t).toMatchObject({ amount: 300, party: "Zomato", category: "food-out", ref: "430912345678" });
  });

  it("turns spent into came in", () => {
    const next = rewriteLine("💸 ₹40 to chai #food", "2026-11-04", { direction: "credit", party: "Ravi", category: "income" })!;
    expect(next).toBe("💰 ₹40.00 from Ravi #income");
    expect(readLine(next, "2026-11-04")!.direction).toBe("credit");
  });

  it("remembers the line and day it came from", () => {
    expect(readLine(line, "2026-11-04")).toMatchObject({ line, day: "2026-11-04" });
  });
});

describe("wrapping a selection", () => {
  const schema = getSchema([StarterKit]);
  it("a bracket typed over selected text wraps it (Android path)", () => {
    let s = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: [p("say hello now")] }) });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 5, 10)));
    const tr = s.tr.insertText("(", 5, 10);
    const after = s.apply(tr);
    const extra = pairFollowUp(tr, s, after)!;
    const out = after.apply(extra);
    expect(out.doc.textContent).toBe("say (hello) now");
    expect(out.doc.textBetween(out.selection.from, out.selection.to)).toBe("hello");
  });

  it("quotes and backticks too", () => {
    for (const [open, close] of [['"', '"'], ["`", "`"], ["[", "]"], ["{", "}"]]) {
      let s = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: [p("word")] }) });
      s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, 5)));
      const tr = s.tr.insertText(open, 1, 5);
      const after = s.apply(tr);
      expect(after.apply(pairFollowUp(tr, s, after)!).doc.textContent).toBe(`${open}word${close}`);
    }
  });

  it("a letter typed over a selection still replaces it", () => {
    let s = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: [p("word")] }) });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, 5)));
    const tr = s.tr.insertText("x", 1, 5);
    expect(pairFollowUp(tr, s, s.apply(tr))).toBeNull();
  });
});

describe("a line remembers when typing in it began", () => {
  const schema = getSchema([StarterKit, BlockBorn]);
  const plugin = () => {
    // The extension's plugin, run by hand like the editor does.
    const ext = BlockBorn as unknown as { config: { addProseMirrorPlugins: (this: unknown) => import("@tiptap/pm/state").Plugin[] } };
    return ext.config.addProseMirrorPlugins.call({ editor: null, options: {} })[0];
  };
  it("stamps an empty line when the first letter is typed, and only then", () => {
    const pl = plugin();
    let s = EditorState.create({ schema, plugins: [pl], doc: schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] }) });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1)));
    s = s.apply(s.tr.insertText("h", 1));
    const born = s.doc.child(0).attrs.born as string;
    expect(typeof born).toBe("string");
    expect(Number.isNaN(Date.parse(born))).toBe(false);
    s = s.apply(s.tr.insertText("i", 2));
    expect(s.doc.child(0).attrs.born).toBe(born);
  });

  it("Entries use it when no time is written", () => {
    const born = "2026-11-04T09:15:00.000Z";
    const t = entryTime({ day: "2026-11-04", lines: ["[[Gym]] squats"], doc: [{ type: "paragraph", attrs: { born }, content: [{ type: "text", text: "[[Gym]] squats" }] }] });
    expect(t?.date.toISOString()).toBe(born);
  });
});

describe("shared clipboard", () => {
  it("tells clips apart by their text", () => {
    expect(textKey("hello")).toBe(textKey("hello"));
    expect(textKey("hello")).not.toBe(textKey("hellp"));
  });
});

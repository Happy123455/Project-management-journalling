// @vitest-environment happy-dom
// Hapi's double lines (16 Nov investigation of the 13–15 Nov notes and both sync logs): each case
// rebuilt here, first as it happened, then fixed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Editor as ReactEditor, JSONContent } from "@tiptap/react";
import { LineIds } from "../editor/lineIds";
import { foldEchoes, mergeDocs, takeMergeNotes } from "./merge";
import { siblingIds } from "./lineIds";
import { forgetStamps, makeStamp, setStampDevice, stampDoc, touchedIds, touchLines } from "./lineStamps";
import { applyTyping, sendTyping, setTypingSink, type TypingMsg } from "./liveTyping";
import { editorSaw, guardSave } from "./saveGuard";

const p = (lid: string | undefined, text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: "paragraph",
  attrs: { ...(lid ? { lid } : {}), ...attrs },
  content: text ? [{ type: "text", text }] : undefined,
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const texts = (d: JSONContent) => (d.content ?? []).map((n) => (n.content ?? []).map((c) => c.text).join(""));
const T0 = Date.parse("2026-11-14T14:14:00Z");
const by = (dev: string, ms: number) => ({ ed: makeStamp(dev, T0 + ms) });

describe("a stale copy of one person's typing never becomes a second line", () => {
  // 14 Nov 19:44–19:49: the Mac's copy had "wnasee", the phone had fixed it a moment later.
  const base = doc(p("rA", "After all this watching all reels", by("phone", 0)));
  const macStale = doc(p("rA", "After all this watching all reels and stuff I don't wnasee", by("phone", 4000)));
  const phoneNow = doc(p("rA", "After all this watching all reels and stuff I don't want to see anything", by("phone", 9000)));
  const want = ["After all this watching all reels and stuff I don't want to see anything"];

  it("whichever side the merge is run from, with or without the last common version", () => {
    for (const b of [base, undefined]) {
      expect(texts(mergeDocs(macStale, phoneNow, b))).toEqual(want);
      expect(texts(mergeDocs(phoneNow, macStale, b))).toEqual(want);
      expect(texts(mergeDocs(macStale, phoneNow, b, true))).toEqual(want);
      expect(texts(mergeDocs(macStale, phoneNow, b, false))).toEqual(want);
    }
  });

  it("no word is written twice by a three-way join of one person's versions", () => {
    const b = doc(p("rB", "I went", by("phone", 0)));
    const older = doc(p("rB", "I went to", by("phone", 1000)));
    const newer = doc(p("rB", "i went to the shop", by("phone", 3000)));
    expect(texts(mergeDocs(newer, older, b))).toEqual(["i went to the shop"]);
    expect(texts(mergeDocs(older, newer, b))).toEqual(["i went to the shop"]);
  });

  it("words deleted on the phone don't come back from the Mac's older copy", () => {
    const out = mergeDocs(doc(p("rC", "this is", by("phone", 5000))), doc(p("rC", "this is wrong text", by("phone", 2000))));
    expect(texts(out)).toEqual(["this is"]);
  });

  it("a real clash (the phone and the Mac both typed in the line) still keeps both", () => {
    const b = doc(p("rD", "We met at the cafe", by("phone", 0)));
    const mac = doc(p("rD", "We met at the old cafe", by("mac", 3000)));
    const phone = doc(p("rD", "We met at the new cafe", by("phone", 4000)));
    expect(texts(mergeDocs(phone, mac, b))).toHaveLength(2);
  });

  it("lines without stamps (older app versions) merge as before", () => {
    expect(texts(mergeDocs(doc(p("rE", "this is and thus how it is")), doc(p("rE", "this is and"))))).toEqual(["this is and thus how it is"]);
  });
});

describe("lines written by the app get the same id on both devices", () => {
  const line = "🎲 How did it go? Pause all new feature requests [[Journal]] (log it on the page)";

  it("with or without the editor's default attributes", () => {
    expect(siblingIds([p(undefined, line)])).toEqual(siblingIds([p(undefined, line, { indent: 0 })]));
  });

  // 22 Nov: the phone had one 🎲 line (id from the editor), the Mac two raw copies; the Mac's
  // merge put the deleted copy back.
  it("a copy deleted on one device doesn't come back from the other's raw copies", () => {
    const [id] = siblingIds([p(undefined, line, { indent: 0 })]);
    const phone = doc(p(id, line, { indent: 0 }));
    const mac = doc(p(undefined, line), p(undefined, line));
    expect(texts(mergeDocs(phone, mac))).toEqual([line]);
  });
});

describe("Enter at the start of a line", () => {
  it("keeps the line's id on its text (the empty line above gets a new one)", async () => {
    const e = new Editor({ extensions: [StarterKit, LineIds], content: "<p>first</p><p>this is and</p>" });
    await Promise.resolve();
    const id = e.getJSON().content![1].attrs!.lid;
    e.commands.setTextSelection(8);
    e.commands.splitBlock();
    const after = e.getJSON().content!;
    expect(after[2].attrs!.lid).toBe(id);
    expect(after[1].attrs!.lid).not.toBe(id);
    // Enter at the end and in the middle: the first part keeps it, as before.
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    e.commands.splitBlock();
    expect(e.getJSON().content![2].attrs!.lid).toBe(id);
    e.destroy();
  });
});

describe("echo check after a merge", () => {
  const now = T0 + 60_000;
  it("folds a newly added older start of a line typed a moment ago, and notes it", () => {
    takeMergeNotes();
    const local = [p("r1", "Morning walk", by("phone", 0)), p("r2", "Compacted coming up section acording to ui stand point there edges isn't right", by("phone", 50_000))];
    const merged = [local[0], p("rX", "Compacted coming up section acording to ui", by("mac", 20_000)), local[1]];
    expect(texts(doc(...foldEchoes(merged, local, now)))).toEqual(["Morning walk", "Compacted coming up section acording to ui stand point there edges isn't right"]);
    const notes = takeMergeNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "folded", line: "rX", after: "r1" });
  });

  it("leaves old lines, short lines, far lines and lines that only look alike", () => {
    const old = [p("r1", "Also there is probelm when i switch tabs"), p("rX", "Also there is probelm when i switch")];
    expect(foldEchoes(old, [old[0]], now)).toHaveLength(2); // no times: not known to be recent
    const short = [p("r1", "ok then", by("phone", 0)), p("rX", "ok", by("phone", 0))];
    expect(foldEchoes(short, [short[0]], now)).toHaveLength(2);
    const far = [p("r1", "A long line about the journal", by("phone", 0)), ...[2, 3, 4, 5].map((i) => p(`f${i}`, `filler ${i}`)), p("rX", "A long line about", by("phone", 0))];
    expect(foldEchoes(far, far.filter((n) => n.attrs!.lid !== "rX"), now)).toHaveLength(6);
    const differ = [p("r1", "Buy milk and eggs today", by("phone", 0)), p("rX", "Buy milk and bread today", by("phone", 0))];
    expect(foldEchoes(differ, [differ[0]], now)).toHaveLength(2);
  });

  it("only runs on merges that know which side is this device's", () => {
    const a = doc(p("r1", "Compacted coming up section acording to ui stand point", by("phone", 0)));
    const b = doc(p("rX", "Compacted coming up section", by("phone", 0)), p("r1", "Compacted coming up section acording to ui stand point", by("phone", 0)));
    vi.setSystemTime(T0 + 1000);
    expect(mergeDocs(a, b).content).toHaveLength(2);
    expect(mergeDocs(a, b, undefined, true).content).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("end to end: the phone types, the Mac shows it live and saves an older copy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    forgetStamps();
  });
  afterEach(() => {
    setTypingSink("", null);
    vi.useRealTimers();
  });
  const make = () => new Editor({ extensions: [StarterKit, LineIds], content: "<p>Morning</p><p></p>" });
  const later = (ms = 300) => vi.advanceTimersByTime(ms);

  it("ends with one line, the phone's newest text", async () => {
    const phone = make();
    const mac = make();
    await Promise.resolve();
    // Both open the same note (same line ids, as after a sync).
    mac.commands.setContent(phone.getJSON());
    const key = "day:2026-11-14";
    const sent: TypingMsg[] = [];
    setStampDevice("phone");
    setTypingSink("phone", (m) => sent.push(m));
    phone.on("update", ({ editor, transaction }) => {
      touchLines(key, touchedIds(transaction, editor.state.doc));
      sendTyping(key, editor.state.doc);
    });
    const type = (s: string) => {
      phone.commands.insertContentAt(phone.state.doc.content.size - 1, s);
      later();
      for (const m of sent.splice(0)) applyTyping(mac as unknown as ReactEditor, m);
    };
    type("After all this watching all reels and stuff I don't wnasee");
    // The Mac saves what it shows now (it never typed in this line).
    setStampDevice("mac");
    const macSaved = stampDoc(key, mac.getJSON());
    setStampDevice("phone");
    // The phone fixes the typo and goes on; the Mac's copy is now behind.
    later(5000);
    const len = "wnasee".length;
    const end = phone.state.doc.content.size - 1;
    phone.commands.deleteRange({ from: end - len, to: end });
    phone.commands.insertContentAt(phone.state.doc.content.size - 1, "want to see anything");
    later();
    // The phone saves: its editor started from the note without this line; the store has the Mac's copy.
    editorSaw(key, { type: "doc", content: [p(phone.getJSON().content![0].attrs!.lid, "Morning")] });
    const out = guardSave(key, stampDoc(key, phone.getJSON()), macSaved);
    expect(texts(out)).toEqual(["Morning", "After all this watching all reels and stuff I don't want to see anything"]);
    phone.destroy();
    mac.destroy();
  });
});

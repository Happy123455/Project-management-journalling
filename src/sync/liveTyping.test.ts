// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Editor as ReactEditor } from "@tiptap/react";
import { LineIds } from "../editor/lineIds";
import { applyTyping, REMOTE, sendTyping, setTypingSink, type TypingMsg } from "./liveTyping";

const make = (html = "<p>one</p><p>two</p>") => new Editor({ extensions: [StarterKit, LineIds], content: html });

describe("letter-by-letter typing between two open notes", () => {
  // Messages go out at most every 250 ms per note: step past that after each edit.
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const later = () => vi.advanceTimersByTime(300);

  it("each letter reaches the other note in place, without becoming an edit there", async () => {
    const mac = make();
    const phone = make();
    await Promise.resolve(); // opened notes get their line ids
    const sent: TypingMsg[] = [];
    setTypingSink("mac", (m) => sent.push(m));
    let phoneEdits = 0;
    phone.on("update", ({ transaction }) => void (!transaction.getMeta(REMOTE) && phoneEdits++));
    mac.on("update", ({ editor }) => sendTyping("day:x", editor.state.doc));
    // Phone's cursor in "one"; Mac types into "two", letter by letter.
    phone.commands.setTextSelection(3);
    expect(phone.state.selection.from).toBe(3);
    for (const ch of "abc") {
      mac.commands.insertContentAt(mac.state.doc.content.size - 1, ch);
      later();
      for (const m of sent.splice(0)) expect(applyTyping(phone as unknown as ReactEditor, m)).toBe(true);
      expect(phone.getJSON()).toEqual(mac.getJSON());
      expect(phone.state.selection.from, ch).toBe(3);
    }
    expect(phone.getText()).toContain("twoabc");
    expect(phoneEdits).toBe(0);
    expect(phone.state.selection.from).toBe(3);
    // A missed message: the next patch doesn't fit and is skipped, nothing breaks.
    mac.commands.insertContentAt(mac.state.doc.content.size - 1, "d");
    later();
    sent.splice(0);
    mac.commands.insertContentAt(mac.state.doc.content.size - 1, "e");
    later();
    expect(applyTyping(phone as unknown as ReactEditor, sent.splice(0)[0])).toBe(false);
    expect(phone.getText()).toContain("twoabc");
    setTypingSink("mac", null);
  });

  it("never takes away a line the other device's open note doesn't have yet (8 Nov lost text)", async () => {
    const mac = make();
    const phone = make("<p>one</p><p>two</p><p>typed on the phone</p>");
    await Promise.resolve();
    const sent: TypingMsg[] = [];
    setTypingSink("mac2", (m) => sent.push(m));
    mac.on("update", ({ editor }) => sendTyping("day:y", editor.state.doc));
    mac.commands.insertContentAt(4, "!");
    later();
    for (const m of sent.splice(0)) applyTyping(phone as unknown as ReactEditor, m);
    expect(phone.getText()).toContain("one!");
    expect(phone.getText()).toContain("typed on the phone");
    // A line the Mac really deleted (it had it in its last message) goes on the phone too.
    mac.commands.setContent("<p>one!</p>");
    later();
    for (const m of sent.splice(0)) applyTyping(phone as unknown as ReactEditor, m);
    expect(phone.getText()).not.toContain("two");
    expect(phone.getText()).toContain("typed on the phone");
    setTypingSink("mac2", null);
  });

  it("fast typing goes out as one message per 250 ms, and the last keys always arrive", async () => {
    const mac = make();
    const phone = make();
    await Promise.resolve();
    const sent: TypingMsg[] = [];
    setTypingSink("mac3", (m) => sent.push(m));
    mac.on("update", ({ editor }) => sendTyping("day:z", editor.state.doc));
    mac.commands.insertContentAt(mac.state.doc.content.size - 1, "a");
    expect(sent.length).toBe(1); // the first key goes at once
    for (const ch of "bcdefgh") mac.commands.insertContentAt(mac.state.doc.content.size - 1, ch);
    expect(sent.length).toBe(1);
    later();
    expect(sent.length).toBe(2);
    for (const m of sent.splice(0)) expect(applyTyping(phone as unknown as ReactEditor, m)).toBe(true);
    expect(phone.getText()).toContain("twoabcdefgh");
    setTypingSink("mac3", null);
  });
});

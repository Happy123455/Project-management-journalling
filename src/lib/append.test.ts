import { describe, expect, it } from "vitest";
import { appendBlocks, asBlocks, textBlocks } from "./append";

describe("appending shared things to a note", () => {
  it("turns shared text into paragraphs with links", () => {
    expect(textBlocks("Look at this\nhttps://example.com/a")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Look at this" }] },
      { type: "paragraph", content: [{ type: "text", text: "https://example.com/a", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] }] },
    ]);
  });

  it("groups inline media into a paragraph and keeps file cards as blocks", () => {
    const img = { type: "attachmentImage", attrs: { fileId: "a" } };
    const card = { type: "attachmentFile", attrs: { fileId: "b" } };
    expect(asBlocks([img, img, card])).toEqual([{ type: "paragraph", content: [img, img] }, card]);
  });

  it("adds to the end of the note, replacing an empty last line", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "morning" }] }, { type: "paragraph" }] };
    const added = appendBlocks(doc, textBlocks("shared"));
    expect(added.content?.map((b) => b.content?.[0]?.text)).toEqual(["morning", "shared"]);
    expect(appendBlocks(null, textBlocks("x")).content).toHaveLength(1);
  });
});

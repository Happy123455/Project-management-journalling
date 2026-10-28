import { describe, expect, it } from "vitest";
import { embedText, hasEmbeds, idFromRef, kindFromName, parseEmbeds } from "./embeds";

describe("embeds", () => {
  it("writes and reads back an embed for a stored file", () => {
    const text = embedText("abc-123", "photo.png", 240);
    expect(text).toBe("![[attachments/abc-123/photo.png|240]]");
    expect(parseEmbeds(`look ${text} here`)).toEqual([
      { type: "text", text: "look " },
      { type: "embed", ref: "attachments/abc-123/photo.png", width: 240 },
      { type: "text", text: " here" },
    ]);
  });

  it("reads bare Obsidian-style names", () => {
    expect(parseEmbeds("![[Invoice October.pdf]]")).toEqual([{ type: "embed", ref: "Invoice October.pdf", width: null }]);
    expect(hasEmbeds("plain [[link]] only")).toBe(false);
    expect(hasEmbeds("a ![[x.gif]] b")).toBe(true);
  });

  it("finds the file id in a stored path", () => {
    expect(idFromRef("attachments/abc-123/photo.png")).toBe("abc-123");
    expect(idFromRef("photo.png")).toBeNull();
  });

  it("guesses the kind from the extension", () => {
    expect(kindFromName("a.GIF")).toBe("image");
    expect(kindFromName("clip.mp4")).toBe("video");
    expect(kindFromName("doc.pdf")).toBe("pdf");
    expect(kindFromName("notes.txt")).toBe("file");
  });
});

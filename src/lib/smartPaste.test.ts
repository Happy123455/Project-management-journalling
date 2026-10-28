// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { classifyClip, cleanPastedHTML, clipKey, clipPreview } from "./smartPaste";

describe("classifyClip", () => {
  it("ignores an empty clipboard", () => {
    expect(classifyClip("")).toBeNull();
    expect(classifyClip("  \n ")).toBeNull();
    expect(classifyClip(null)).toBeNull();
  });

  it("recognises a lone link", () => {
    expect(classifyClip(" https://example.com/a?b=1 ")).toEqual({ kind: "url", url: "https://example.com/a?b=1" });
  });

  it("treats a link inside a sentence as text", () => {
    expect(classifyClip("see https://example.com")).toMatchObject({ kind: "text" });
  });

  it("counts lines of text, normalising Windows line ends", () => {
    expect(classifyClip("one\r\ntwo\nthree")).toEqual({ kind: "text", text: "one\ntwo\nthree", lines: 3 });
  });
});

describe("clipKey and clipPreview", () => {
  it("gives the same key for the same text and different keys otherwise", () => {
    expect(clipKey("hello")).toBe(clipKey("hello"));
    expect(clipKey("hello")).not.toBe(clipKey("hello!"));
  });

  it("previews the first line, shortened", () => {
    expect(clipPreview({ kind: "text", text: "first line\nsecond", lines: 2 })).toBe("first line");
    expect(clipPreview({ kind: "url", url: "https://example.com" })).toBe("example.com");
    expect(clipPreview({ kind: "text", text: "x".repeat(60), lines: 1 }, 10)).toBe("xxxxxxxxx…");
  });
});

describe("cleanPastedHTML", () => {
  it("drops styling but keeps structure and links", () => {
    const html = `<style>p{}</style><p class="x" style="color:red"><span style="font-size:20px">Hi <b>there</b></span> <a href="https://a.com" target="_blank" style="color:blue">link</a></p>`;
    expect(cleanPastedHTML(html)).toBe(`<p>Hi <b>there</b> <a href="https://a.com">link</a></p>`);
  });
});

import { describe, expect, it } from "vitest";
import { parseMeta, youtubeId } from "./linkPreview";

describe("link previews", () => {
  it("finds YouTube video ids in every link shape", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://m.youtube.com/shorts/abc_DEF-123")).toBe("abc_DEF-123");
    expect(youtubeId("https://example.com/watch?v=1")).toBeNull();
  });

  it("reads Open Graph tags, with fallbacks", () => {
    const html = `<head><meta property="og:title" content="Tom &amp; Jerry"><meta content="/img/a.png" property="og:image"><meta property="og:site_name" content="Cartoons"></head>`;
    expect(parseMeta(html, "https://example.com/x")).toEqual({ title: "Tom & Jerry", site: "Cartoons", image: "https://example.com/img/a.png" });
    expect(parseMeta("<title> Plain page </title>", "https://www.site.org/p")).toEqual({ title: "Plain page", site: "site.org", image: null });
  });
});

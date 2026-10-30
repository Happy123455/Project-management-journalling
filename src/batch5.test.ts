import { describe, expect, it } from "vitest";
import { weekendsUntil } from "./calendar/Upcoming";
import { youtubeEmbedFrom } from "./editor/youtubeEmbed";
import { cleanAnswer } from "./editor/promptBlock";

describe("batch 5", () => {
  it("counts Saturdays and Sundays after today up to the deadline", () => {
    // Fri 30 Oct 2026 → Sun 8 Nov 2026: Sat 31, Sun 1, Sat 7, Sun 8.
    expect(weekendsUntil("2026-10-30", "2026-11-08")).toEqual({ saturdays: 2, sundays: 2 });
    expect(weekendsUntil("2026-10-30", "2026-10-30")).toEqual({ saturdays: 0, sundays: 0 });
  });
  it("reads Obsidian-style ![](youtube) embeds, with an optional width", () => {
    expect(youtubeEmbedFrom("![](https://youtu.be/abc123)")).toEqual({ url: "https://youtu.be/abc123", width: null });
    expect(youtubeEmbedFrom("![|400](https://www.youtube.com/watch?v=abc123)")).toEqual({ url: "https://www.youtube.com/watch?v=abc123", width: 400 });
    expect(youtubeEmbedFrom("![](https://example.com/a.png)")).toBeNull();
  });
  it("keeps only the prompt from an AI answer", () => {
    expect(cleanAnswer('<think>hm</think>\n"Write a poem."')).toBe("Write a poem.");
    expect(cleanAnswer("```\nDo X\n```")).toBe("Do X");
  });
});

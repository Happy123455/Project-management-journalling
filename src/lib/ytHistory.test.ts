import { describe, expect, it } from "vitest";
import { categoryOf, lastDays, likeLine, likeScores, likesFromText, parseHistory, watchMinutes, ytStats } from "./ytHistory";

const tk = (kind: string, title: string, id: string, channel: string, time: string, ad = false) => ({
  header: "YouTube", title: `${kind} ${title}`, titleUrl: `https://www.youtube.com/watch?v=${id}`, subtitles: [{ name: channel }], time, ...(ad ? { details: [{ name: "From Google Ads" }] } : {}),
});

describe("YouTube history", () => {
  const file = [
    tk("Watched", "Python tutorial for beginners", "aaaaaa1", "CodeCamp", "2026-11-10T10:00:00Z"),
    tk("Watched", "Funny cats compilation", "bbbbbb2", "Pets", "2026-11-10T10:05:00Z"),
    tk("Watched", "Buy this car", "cccccc3", "Ads", "2026-11-10T10:06:00Z", true),
    tk("Watched", "Python decorators explained", "dddddd4", "CodeCamp", "2026-11-10T10:08:00Z"),
    tk("Liked", "Python tutorial for beginners", "aaaaaa1", "CodeCamp", "2026-11-10T10:04:00Z"),
  ];
  it("reads Takeout: watches without ads, likes", () => {
    const h = parseHistory(file);
    expect(h.watches.map((w) => w.id)).toEqual(["aaaaaa1", "bbbbbb2", "dddddd4"]);
    expect(h.likes).toMatchObject([{ id: "aaaaaa1", title: "Python tutorial for beginners", channel: "CodeCamp" }]);
  });
  it("reads the extension's export too", () => {
    const h = parseHistory({ watches: [{ videoId: "xyzxyz1", title: "Lo-fi beats", channel: "Chill", watchedAt: "2026-11-15T08:00:00Z" }] });
    expect(h.watches[0]).toMatchObject({ id: "xyzxyz1", channel: "Chill" });
  });
  it("estimates minutes from the gaps, sorts kinds and suggests more like the likes", () => {
    const h = parseHistory(file);
    expect(watchMinutes(h.watches)).toEqual([5, 3, 5]);
    expect(categoryOf(h.watches[0])).toBe("learning");
    expect(categoryOf(h.watches[1])).toBe("entertainment");
    const s = ytStats(h.watches);
    expect(s.videos).toBe(3);
    expect(s.categories[0]).toMatchObject({ id: "learning", n: 2 });
    expect([...likeScores(h.watches, h.likes).keys()]).toEqual(["dddddd4"]);
    expect(lastDays(h.watches, 1).length).toBe(3);
  });
  it("❤ lines round trip", () => {
    const l = { id: "aaaaaa1", title: "Python tutorial", channel: "CodeCamp" };
    expect(likesFromText(`x\n${likeLine(l)}\n`)).toEqual([l]);
  });
});

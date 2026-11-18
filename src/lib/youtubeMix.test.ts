import { describe, expect, it } from "vitest";
import { purposeOf, youtubeMix, type YoutubeDay } from "./youtubeDigest";

const day = (d: Partial<YoutubeDay>): YoutubeDay => ({ day: "2026-11-15", watches: 0, useful: 0, distraction: 0, unlabelled: 0, shorts: 0, topics: [], usefulVideos: [], note: "", focus: [], rising: [], ...d });

describe("youtube mix", () => {
  it("groups topics by purpose", () => {
    expect(purposeOf("kitten")).toBe("entertainment");
    expect(purposeOf("AI")).toBe("learning");
    expect(purposeOf("gym motivation")).toBe("motivation");
    expect(purposeOf("zzz")).toBe("other");
    expect(purposeOf("zzz", { zzz: "news" })).toBe("news");
  });
  it("adds up days", () => {
    const m = youtubeMix([day({ watches: 10, useful: 2, distraction: 8, shorts: 7, topics: [{ t: "gaming", n: 4 }, { t: "ai", n: 2 }] }), day({ day: "2026-11-16", watches: 5, unlabelled: 5, topics: [{ t: "Gaming", n: 3 }] })]);
    expect(m.watches).toBe(15);
    expect(m.verdict.map((v) => v.n)).toEqual([2, 8, 5]);
    expect(m.purposes.find((p) => p.id === "entertainment")?.n).toBe(7);
    expect(m.purposes.find((p) => p.id === "unsorted")?.n).toBe(6);
    expect(m.topics[0]).toMatchObject({ t: "gaming", n: 7 });
  });
});

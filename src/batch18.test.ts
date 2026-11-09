import { describe, expect, it } from "vitest";
import { docMatches, docNames, parseQuery } from "./lib/search";
import { stampsIn } from "./lib/timeGaps";

describe("file:(…) search", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "met alphabet today" }] }, { type: "linkCard", attrs: { url: "https://x.y", title: "Microsoft careers" } }] };
  it("parses as its own scope", () => expect(parseQuery("file:(microsoft)").groups).toEqual([{ scope: "file", terms: ["microsoft"] }]));
  it("matches titles and link titles only", () => {
    expect(docNames(doc as never, "Jobs")).toContain("microsoft careers");
    expect(docMatches(doc as never, "file:(microsoft)")).toBe(true);
    expect(docMatches(doc as never, "file:(alphabet)")).toBe(false);
    expect(docMatches(doc as never, "file:(jobs)", "Jobs")).toBe(true);
  });
});

describe("✎ stamps", () => {
  it("are marked as edits", () => {
    const s = stampsIn([{ pos: 1, text: "✎ 9,November,2026 Monday (14:30:12) fixed" }, { pos: 50, text: "27,October,2026 Tuesday (22:04:26) wrote" }]);
    expect(s.map((x) => !!x.edit)).toEqual([true, false]);
  });
});

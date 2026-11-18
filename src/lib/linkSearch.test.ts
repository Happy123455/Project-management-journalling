import { describe, expect, it } from "vitest";
import { insideMatches, linkBefore, searchQuery, sectionFor } from "./linkSearch";

const doc = (...lines: string[]) => ({ type: "doc", content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) });

describe("search inside a linked note", () => {
  it("finds the link a ]] closes", () => {
    expect(linkBefore("made [[Recipes")).toBe("Recipes");
    expect(linkBefore("see ![[Ravi Patel")).toBe("Ravi Patel");
    expect(linkBefore("no link here")).toBeNull();
    expect(linkBefore("[[Note#Part")).toBeNull();
    expect(linkBefore("[[Done]] and more")).toBeNull();
  });
  it("takes short plain text after the brackets as the search", () => {
    expect(searchQuery("paneer")).toBe("paneer");
    expect(searchQuery(" paneer tikka")).toBe("paneer tikka");
    expect(searchQuery("a")).toBeNull();
    expect(searchQuery("  two spaces")).toBeNull();
    expect(searchQuery(" ")).toBeNull();
    expect(searchQuery("x".repeat(60))).toBeNull();
  });
  it("keeps a findable piece of the line", () => {
    expect(sectionFor("Paneer butter masala with rice", "butt")).toBe("Paneer butter masala with");
    expect(sectionFor("one two three four five [six] seven", "seven")).toBe("four five six seven");
    expect(sectionFor("Call #mom about it.", "mom")).toBe("Call mom about it");
  });
  it("lists matching lines once", () => {
    const hits = insideMatches(doc("Paneer tikka", "Dal", "paneer butter masala", "Paneer tikka"), "paneer");
    expect(hits.map((h) => h.section)).toEqual(["Paneer tikka", "paneer butter masala"]);
    expect(insideMatches(doc("Dal"), "paneer")).toEqual([]);
    expect(insideMatches(null, "x")).toEqual([]);
  });
});

import { projectWith } from "./projects";
describe("project changes keep the rest", () => {
  it("keeps the tool bar button and icon when the status or kind changes", () => {
    const page = { props: { project: { status: "active" as const, quickLog: true, icon: "🏋️" } } };
    expect(projectWith(page, { status: "paused" })).toEqual({ status: "paused", quickLog: true, icon: "🏋️" });
    expect(projectWith(page, { kind: "logging" })).toEqual({ status: "active", kind: "logging", quickLog: true, icon: "🏋️" });
    expect(projectWith({ props: { project: { status: "active", kind: "logging" } } }, { kind: undefined })).toEqual({ status: "active" });
  });
});

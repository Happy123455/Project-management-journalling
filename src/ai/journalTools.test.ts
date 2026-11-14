// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { mcpToolList, runMcpTool } from "../mcp";
import { declarations } from "./geminiTools";
import { TOOL_SPECS, AI_OPEN_EVENT } from "./journalTools";
import { toolsFor } from "./agent";
import { loadYoutubeDay } from "../lib/youtubeDigest";

const now = new Date(2026, 10, 14, 9, 0);
const call = (store: MemoryStore, tool: string, args: Record<string, unknown>) => runMcpTool(store, { tool, args, actor: "Gemini" }, now);
const txt = (r: { content: { text: string }[] }) => r.content[0].text;

describe("the shared AI tools", () => {
  it("tables: add one, set cells and formulas, read them back; the write is the AI's", async () => {
    const store = new MemoryStore();
    await call(store, "append", { text: "Budget" });
    const add = await call(store, "add_sheet", { cells: [{ ref: "A1", value: "Rent" }, { ref: "B1", value: "900" }, { ref: "A2", value: "Food" }, { ref: "B2", value: "300" }] });
    expect(add.isError).toBeUndefined();
    const set = await call(store, "set_cells", { cells: [{ ref: "A3", value: "Total" }, { ref: "B3", value: "=SUM(B1:B2)" }] });
    expect(txt(set)).toContain("B3: =SUM(B1:B2) → 1200");
    expect(txt(await call(store, "read_sheet", {}))).toContain("B3: =SUM(B1:B2) → 1200");
    // Object form works too (local models write it that way).
    expect((await call(store, "set_cells", { cells: { C1: "=B1*12" } })).isError).toBeUndefined();
    const day = (await store.getDay("2026-11-14"))!;
    const events = await store.eventsFor(day.id);
    expect(events[events.length - 1].actor).toBe("Gemini");
    expect(txt(await call(store, "read_day", { date: "2026-11-14" }))).toContain("Rent\t900\t10800");
    expect((await call(store, "set_cells", { sheet: 3, cells: [{ ref: "A1", value: "x" }] })).isError).toBe(true);
    expect((await call(store, "set_cells", { cells: [{ ref: "nope", value: "x" }] })).isError).toBe(true);
  });

  it("opens notes that exist, lists projects, adds rules it can follow", async () => {
    const store = new MemoryStore();
    await store.ensurePage("Fitness");
    const opened: string[] = [];
    const on = (e: Event) => opened.push((e as CustomEvent).detail.target);
    window.addEventListener(AI_OPEN_EVENT, on);
    expect((await call(store, "open_note", { target: "Fitness" })).isError).toBeUndefined();
    expect((await call(store, "open_note", { target: "today" })).isError).toBeUndefined();
    const missing = await call(store, "open_note", { target: "Fit" });
    expect(missing.isError).toBe(true);
    expect(txt(missing)).toContain("Fitness");
    window.removeEventListener(AI_OPEN_EVENT, on);
    expect(opened).toEqual(["Fitness", "today"]);
    expect((await call(store, "add_rule", { rule: "weekdays 09:00 open [[Fitness]]" })).isError).toBeUndefined();
    expect((await call(store, "add_rule", { rule: "sometimes maybe" })).isError).toBe(true);
    expect(txt(await call(store, "read_page", { title: "AI rules" }))).toContain("weekdays 09:00 open [[Fitness]]");
    expect(txt(await call(store, "list_projects", {}))).toMatch(/No projects|Fitness/);
  });

  it("keeps the YouTube digest for the day's card", async () => {
    const store = new MemoryStore();
    const data = JSON.stringify({ watches: 9, useful: 4, distraction: 3, shorts: 2, topics: [{ t: "linear algebra", n: 3 }], usefulVideos: [{ id: "abcdefghijk", title: "Lecture", channel: "MIT" }, { id: "bad id!", title: "x" }], note: "More maths." });
    expect((await call(store, "youtube_day", { date: "2026-11-13", data })).isError).toBeUndefined();
    const d = (await loadYoutubeDay(store, "2026-11-13"))!;
    expect(d.useful).toBe(4);
    expect(d.usefulVideos).toHaveLength(1);
    expect((await call(store, "youtube_day", { date: "2026-11-13", data: "{oops" })).isError).toBe(true);
  });

  it("one list of tools for every model; Gemini gets no empty parameter objects", () => {
    const names = mcpToolList().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_sheet", "set_cells", "add_sheet", "open_note", "add_rule", "youtube_day", "append"]));
    expect(new Set(names).size).toBe(names.length);
    const decl = declarations(toolsFor(null));
    expect(decl.find((d) => d.name === "today")).not.toHaveProperty("parameters");
    expect(decl.find((d) => d.name === "set_cells")?.parameters?.required).toEqual(["cells"]);
    expect(TOOL_SPECS.every((t) => t.description.length > 10)).toBe(true);
    // A picked section: reading and that section's block tools only.
    expect(toolsFor({ day: "2026-11-14", label: "x", from: 0, to: 1 } as never).some((t) => t.name === "set_cells")).toBe(false);
  });
});

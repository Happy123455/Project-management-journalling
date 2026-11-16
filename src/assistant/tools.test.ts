// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { docText } from "../lib/words";
import { declarations } from "../ai/geminiTools";
import { assistantToolList, runAssistantTool, type RunCtx } from "./tools";
import { linesAsSteps, looksLong } from "./runner";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const task = (text: string, checked = false) => ({ type: "taskList", content: [{ type: "taskItem", attrs: { checked }, content: [p(text)] }] });
const now = new Date(2026, 10, 16, 10, 0);
const ctx = (store: MemoryStore, confirm?: RunCtx["confirm"]): RunCtx => ({ store, actor: "Assistant", now, confirm, touched: new Set(), found: [], opened: [] });

describe("assistant tools", () => {
  it("are valid Gemini declarations, with no duplicate names", () => {
    const list = assistantToolList();
    expect(new Set(list.map((t) => t.name)).size).toBe(list.length);
    expect(declarations(list).length).toBe(list.length);
  });
  it("finds an unticked task and copies it under Journal in today's note", async () => {
    const store = new MemoryStore();
    await store.saveDay({ day: "2026-11-10", content: { type: "doc", content: [task("college form"), task("old", true)] }, plainText: "" });
    await store.saveDay({ day: "2026-11-16", content: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Journal" }] }, p("today")] }, plainText: "" });
    const c = ctx(store);
    const found = await runAssistantTool({ name: "find_tasks", arguments: {} }, c);
    expect(found.out).toBe("1. [2026-11-10] ☐ college form");
    const r = await runAssistantTool({ name: "copy_task", arguments: { n: 1, under: "Journal" } }, c);
    expect(r.bad).toBe(false);
    const today = await store.getDay("2026-11-16");
    expect(docText(today!.content)).toContain("college form");
    expect((await store.aiChanges(5))[0].event.actor).toBe("Assistant");
  });
  it("asks before a second note or a delete, and a scheduled run can't", async () => {
    const store = new MemoryStore();
    const confirm = vi.fn(async () => false);
    const c = ctx(store, confirm);
    expect((await runAssistantTool({ name: "append", arguments: { text: "a" } }, c)).bad).toBe(false);
    const second = await runAssistantTool({ name: "append", arguments: { text: "b", date: "2026-11-15" } }, c);
    expect(confirm).toHaveBeenCalledWith("Also change 2026-11-15?");
    expect(second.bad).toBe(true);
    expect(await store.getDay("2026-11-15")).toBeNull();
    const headless = ctx(store);
    const del = await runAssistantTool({ name: "replace_text", arguments: { find: "a", replace: "" } }, headless);
    expect(del.out).toMatch(/needs the person's OK/);
  });
  it("lists days that mention something, oldest first", async () => {
    const store = new MemoryStore();
    for (const d of ["2026-07-03", "2026-07-01", "2026-07-02"]) await store.saveDay({ day: d, content: { type: "doc", content: [p("college day")] }, plainText: "college day" });
    const r = await runAssistantTool({ name: "day_list", arguments: { query: "college" } }, ctx(store));
    expect(r.out).toContain("1. 2026-07-01\n2. 2026-07-02\n3. 2026-07-03");
  });
  it("splits a block into steps", () => {
    expect(linesAsSteps("1. find a task\n- open today\n\n[ ] read it")).toEqual(["find a task", "open today", "read it"]);
    expect(looksLong("find a task then open it then read it")).toBe(true);
    expect(looksLong("open yesterday")).toBe(false);
  });
});

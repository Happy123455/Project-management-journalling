// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./store/memoryStore";
import { runMcpTool } from "./mcp";

const now = new Date(2026, 9, 29, 9, 0);

describe("MCP tools", () => {
  it("appends to today under the client's name and reads it back", async () => {
    const store = new MemoryStore();
    const added = await runMcpTool(store, { tool: "append", args: { text: "Call [[Asha]] about the trip" }, actor: "claude-ai" }, now);
    expect(added.isError).toBeUndefined();
    const today = await runMcpTool(store, { tool: "today", args: {}, actor: "claude-ai" }, now);
    expect(today.content[0].text).toContain("Call [[Asha]] about the trip");
    const page = (await store.getDay("2026-10-29"))!;
    const events = await store.eventsFor(page.id);
    expect(events[events.length - 1].actor).toBe("claude-ai");
    expect((await store.aiChanges(5)).map((c) => c.event.actor)).toContain("claude-ai");
  });

  it("searches and refuses bad dates", async () => {
    const store = new MemoryStore();
    await runMcpTool(store, { tool: "append", args: { text: "Bought a red kite", date: "2026-10-20" }, actor: "x" }, now);
    expect((await runMcpTool(store, { tool: "search", args: { query: "kite" }, actor: "x" }, now)).content[0].text).toContain("2026-10-20");
    expect((await runMcpTool(store, { tool: "read_day", args: { date: "yesterday" }, actor: "x" }, now)).isError).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { loadoutFrom, loadoutPageContent, parseLoadout } from "./canvasLoadout";

const data = {
  features: [{ id: "sync", label: "Sync" }, { id: "ui", label: "Looks" }],
  prompts: [
    { t: "2026-10-28T13:23:39", text: "fix sync. also nicer looks", thread: "Plan" },
    { t: "2026-10-29T09:00:00", text: "sync again" },
  ],
  segs: [
    { p: 0, k: 0, f: "sync", text: "fix sync. " },
    { p: 0, k: 1, f: "ui", text: "also nicer looks" },
    { p: 1, k: 0, f: "sync", text: "sync again" },
  ],
};

describe("graph loadouts", () => {
  it("reads the map's .html (its DATA line), a .json file, and the saved page", () => {
    const html = `<html><script>\nconst DATA=${JSON.stringify(data)};\nconst MON=[];\n</script>`;
    expect(parseLoadout(html)?.segs).toHaveLength(3);
    expect(parseLoadout(JSON.stringify(data))?.features).toHaveLength(2);
    const page = loadoutPageContent(data).content[0].content[0].text;
    expect(parseLoadout(page)?.prompts).toHaveLength(2);
    expect(parseLoadout("no graph here")).toBeNull();
  });

  it("puts each part of a prompt on its feature's branch, at the prompt's wall-clock time", () => {
    const L = loadoutFrom(data, "Prompts");
    expect(L.items).toHaveLength(3);
    expect(L.branches.get("g1")).toBe("Looks");
    expect(new Date(L.items[0].ms).getHours()).toBe(13);
    expect(L.items[0].day).toBe("2026-10-28");
    const info = L.info.get("g1")!;
    expect(info.parts).toEqual(["g0", "g1"]);
    expect(info.full.slice(info.start, info.end)).toBe("also nicer looks");
    expect(info.thread).toBe("Plan");
  });
});

describe("save_graph (MCP)", () => {
  it("saves a graph page whose links and tags aren't read from the prompts", async () => {
    const { MemoryStore } = await import("../store/memoryStore");
    const { runMcpTool } = await import("../mcp");
    const store = new MemoryStore();
    const withLink = { ...data, prompts: [{ t: "2026-10-28T13:23:39", text: "see [[Journal]] #idea" }], segs: [{ p: 0, f: "sync", text: "see [[Journal]] #idea" }] };
    const r = await runMcpTool(store, { tool: "save_graph", args: { title: "Prompts", data: JSON.stringify(withLink) }, actor: "Claude" });
    expect(r.isError).toBeFalsy();
    const page = await store.getPage("Graph · Prompts");
    expect(parseLoadout(page!.content.content![0].content![0].text!)?.segs).toHaveLength(1);
    expect(await store.references("wikilink", "Journal")).toHaveLength(0);
  });
});

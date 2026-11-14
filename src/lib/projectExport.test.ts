// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { docText } from "./words";
import { loadoutFrom, loadoutPageContent, parseLoadout } from "./canvasLoadout";
import { mindMapFromGraph } from "./graphFormat";
import { buildProjectExport, EXPORT_FORMAT, exportMarkdown, lineDiff } from "./projectExport";
import type { Chat } from "../ai/chatRunner";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const h = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const doc = (...content: unknown[]) => ({ type: "doc", content }) as never;

describe("project export for AI", () => {
  it("lineDiff counts repeated lines", () => {
    expect(lineDiff("a\nb\nb", "b\nc\nb\nb")).toEqual({ added: ["c", "b"], removed: ["a"] });
  });

  it("has the page, notes, edits, chats, media, and a graph Canvas and the mind map open", async () => {
    const store = new MemoryStore();
    const page = await store.ensurePage("Garden");
    const pageDoc = doc(p("Grow vegetables on the roof."), h("Watering"), p("Drip irrigation for tomatoes."), h("Budget"), p("Soil and pots cost money."));
    await store.savePage({ id: page.id, content: pageDoc, plainText: docText(pageDoc) });
    const photo = await store.saveFile({ name: "roof.jpg", mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) });
    // The photo is on the project's line; the one on the dentist line isn't the project's.
    const other = await store.saveFile({ name: "teeth.jpg", mime: "image/jpeg", bytes: new Uint8Array([4]) });
    const day1 = doc(
      { type: "paragraph", content: [{ type: "text", text: "[[Garden]] bought tomatoes seeds, watering twice a day for tomatoes " }, { type: "attachmentImage", attrs: { fileId: photo.id, name: "roof.jpg" } }] },
      { type: "paragraph", content: [{ type: "text", text: "unrelated: dentist at 5 " }, { type: "attachmentImage", attrs: { fileId: other.id, name: "teeth.jpg" } }] },
    );
    await store.saveDay({ day: "2026-11-10", content: day1, plainText: docText(day1) });
    const day2 = doc(p("[[Garden]] the money for soil was 400"));
    await store.saveDay({ day: "2026-11-12", content: day2, plainText: docText(day2) });
    const day2b = doc(p("[[Garden]] the money for soil was 450"), p("[[Garden]] pots arrived"));
    await store.saveDay({ day: "2026-11-12", content: day2b, plainText: docText(day2b), actor: "Gemini" });
    const chats: Chat[] = [
      { id: "c1", title: "Roof garden plan", updated: Date.parse("2026-11-13T10:00:00Z"), messages: [{ role: "user", content: "How do I set up drip irrigation for the Garden?" }, { role: "assistant", content: "Use a timer.", by: "Qwen" }] },
      { id: "c2", title: "Taxes", updated: 1, messages: [{ role: "user", content: "GST?" }] },
    ];
    const pageNow = (await store.getPage("Garden"))!;
    const x = await buildProjectExport(store, pageNow, chats, new Date(2026, 10, 14, 12));

    expect(x.format).toBe(EXPORT_FORMAT);
    expect(x.notes.map((n) => n.day)).toEqual(["2026-11-10", "2026-11-12"]);
    expect(x.notes[0].text).not.toContain("dentist");
    expect(x.chats.map((c) => c.title)).toEqual(["Roof garden plan"]);
    expect(x.media).toEqual([expect.objectContaining({ id: photo.id, name: "roof.jpg", where: "day: 2026-11-10" })]);
    // The AI's change on 12 Nov is in the history, as lines.
    const ai = x.edits.find((e) => e.actor === "Gemini")!;
    expect(ai.added).toContain("[[Garden]] the money for soil was 450");
    expect(ai.removed).toContain("[[Garden]] the money for soil was 400");
    expect(x.edits.every((e) => !e.added.some((l) => l.includes("dentist")))).toBe(true);

    // The graph: page sections are branches; note lines join the section they talk about.
    const branch = (needle: string) => x.features.find((f) => f.id === x.segs.find((s) => s.text.includes(needle))?.f)?.label;
    expect(branch("Drip irrigation")).toBe("📄 Watering");
    expect(branch("watering twice")).toBe("📄 Watering");
    expect(branch("money for soil was 450")).toBe("📄 Budget");
    expect(branch("pots arrived")).toBe("📅 Notes");
    expect(branch("drip irrigation for the Garden")).toBe("💬 AI chats");
    for (const pr of x.prompts.keys()) expect(x.segs.filter((s) => s.p === pr).map((s) => s.text).join("")).toBe(x.prompts[pr].text);

    // The export file itself loads in Canvas and the mind map.
    const back = parseLoadout(JSON.stringify(x, null, 1))!;
    expect(back.segs.length).toBe(x.segs.length);
    expect(loadoutFrom(back, "Garden").items.length).toBe(x.segs.length);
    expect(mindMapFromGraph(back, "Garden").nodes.length).toBeGreaterThan(x.features.length);
    expect(loadoutPageContent(back).content[0].type).toBe("codeBlock");
    expect(exportMarkdown(x)).toContain("### 2026-11-12");
  });
});

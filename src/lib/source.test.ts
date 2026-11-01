import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { AttachmentFile, AttachmentImage, AttachmentMedia } from "../editor/attachments";
import { LinkCard } from "../editor/linkCard";
import { YoutubeEmbed } from "../editor/youtubeEmbed";
import { PromptBlock } from "../editor/promptBlock";
import { JournalCodeBlock } from "../editor/codeBlock";
import { Blocks } from "../editor/blocks";
import { BlockInfoExtension } from "../editor/blockInfo";
import { docToSource, sourceMemory, sourceToDoc } from "./source";

const schema = getSchema([
  StarterKit.configure({ codeBlock: false }), JournalCodeBlock, Highlight, TaskList, TaskItem.configure({ nested: true }),
  AttachmentImage, AttachmentMedia, AttachmentFile, LinkCard, YoutubeEmbed, PromptBlock, Blocks, BlockInfoExtension,
]);
const norm = (d: JSONContent) => schema.nodeFromJSON(d).toJSON();
const t = (text: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]) => ({ type: "text", text, ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}) });
const p = (...content: JSONContent[]) => ({ type: "paragraph", content });

const rich: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [t("Morning "), t("run", "bold")] },
    p(t("27,October,2026 Tuesday (22:04:26) went to "), t("[[Gym]]"), t(" with "), t("Ravi", "italic"), t(" #fit")),
    p(t("5*3 = 15, a ~~ b, == c, `tick`, \\ slash, [x](y) and ![not media]")),
    p(t("bold+italic", "bold", "italic"), t(" "), t("mark", "highlight"), t(" "), t("gone", "strike"), t(" "), t("code", "code"), t(" "), t("under", "underline"), t(" "), t("site", { type: "link", attrs: { href: "https://example.com/a_(b)" } })),
    p(t("line one"), { type: "hardBreak" }, t("line two")),
    { type: "paragraph", attrs: { indent: 1, info: { Day: "4" } }, content: [t("nested with info")] },
    { type: "paragraph", attrs: { indent: 0, collapsed: true }, content: [t("folded parent")] },
    { type: "paragraph", attrs: { indent: 1 }, content: [t("child")] },
    p(t("# not a heading")),
    p(t("- not a list")),
    p(),
    p(t("gif "), { type: "attachmentMedia", attrs: { fileId: "f1", name: "gif-dance.mp4", kind: "video", mime: "video/mp4", size: 123, align: "free", width: 0.35, x: 0.1, y: -0.04, units: "note" } }, t(" here")),
    p({ type: "attachmentImage", attrs: { fileId: "f2", name: "photo.jpg", width: 300, align: "center" } }),
    p({ type: "youtubeEmbed", attrs: { url: "https://youtu.be/dQw4w9WgXcQ", align: "inline" } }),
    { type: "bulletList", content: [
      { type: "listItem", content: [p(t("one")), { type: "bulletList", content: [{ type: "listItem", content: [p(t("one-a"))] }] }] },
      { type: "listItem", content: [p(t("two")), p(t("two second para"))] },
    ] },
    { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p(t("three"))] }, { type: "listItem", content: [p(t("four"))] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(t("done"))] }, { type: "taskItem", attrs: { checked: false }, content: [p(t("todo"))] }] },
    { type: "blockquote", content: [p(t("quoted")), p(t("second"))] },
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;\n  **not bold**" }] },
    { type: "horizontalRule" },
    { type: "linkCard", attrs: { url: "https://example.com", title: "Example", site: "example.com", image: null, status: "ok" } },
    { type: "attachmentFile", attrs: { fileId: "f3", name: "doc.zip", mime: "application/zip", size: 9 } },
    { type: "promptBlock", attrs: { title: "Refine", template: "Fix {{text}}", values: { text: "hi" } } },
  ],
};

describe("source mode", () => {
  it("goes to plain characters and back without losing anything", () => {
    const src = docToSource(rich);
    const back = sourceToDoc(src, sourceMemory(rich));
    expect(norm(back)).toEqual(norm(rich));
  });

  it("writes Markdown that reads like Obsidian's", () => {
    const src = docToSource(rich);
    expect(src).toContain("## Morning **run**");
    expect(src).toContain("- one\n\t- one-a");
    expect(src).toContain("3. three\n4. four");
    expect(src).toContain("- [x] done\n- [ ] todo");
    expect(src).toContain("![[attachments/f1/gif-dance.mp4|align=free w=35% x=10% y=-4%]]");
    expect(src).toContain("```ts\nconst a = 1;");
    expect(src).toContain("🔗 https://example.com");
    expect(src).toContain("\\# not a heading");
  });

  it("reads typed Markdown into blocks", () => {
    const doc = sourceToDoc("# Title\nplain **b** and [[Link]]\n- a\n- b\n\t- c\n1. x\n> q\n---\n![[attachments/z9/pic.png|w=50%]]");
    const types = doc.content!.map((b) => b.type);
    expect(types).toEqual(["heading", "paragraph", "bulletList", "orderedList", "blockquote", "horizontalRule", "paragraph"]);
    expect(doc.content![6].content![0]).toMatchObject({ type: "attachmentImage", attrs: { fileId: "z9", width: 0.5, units: "note" } });
    expect(doc.content![1].content).toEqual([t("plain "), t("b", "bold"), t(" and [[Link]]")]);
  });

  it("keeps an unpaired * as a character", () => {
    expect(sourceToDoc("2*3 is six").content![0].content).toEqual([t("2*3 is six")]);
  });
});

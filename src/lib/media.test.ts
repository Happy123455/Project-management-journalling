import { describe, expect, it } from "vitest";
import { mediaIdsIn } from "./media";

describe("mediaIdsIn", () => {
  it("lists each file a page shows once, in order", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "attachmentImage", attrs: { fileId: "a" } }, { type: "text", text: "hi" }] },
        { type: "attachmentFile", attrs: { fileId: "b" } },
        { type: "paragraph", content: [{ type: "attachmentMedia", attrs: { fileId: "c" } }, { type: "attachmentImage", attrs: { fileId: "a" } }] },
      ],
    };
    expect(mediaIdsIn(doc)).toEqual(["a", "b", "c"]);
    expect(mediaIdsIn(null)).toEqual([]);
  });
});

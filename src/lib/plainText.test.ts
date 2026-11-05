import { describe, expect, it } from "vitest";
import { plainLinks, plainText } from "./plainText";

describe("plain text copy", () => {
  it("keeps an empty [[ ]] as written and still names real links", () => {
    expect(plainLinks("todo [[ ]] and [[Gym]]")).toBe("todo [[ ]] and Gym");
    expect(plainText([{ type: "paragraph", content: [{ type: "text", text: "a [[ ]] b" }] }])).toBe("a [[ ]] b");
  });
});

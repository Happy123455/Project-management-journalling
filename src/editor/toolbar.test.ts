import { describe, expect, it } from "vitest";
import { arrangeTools } from "./JournalEditor";

const tools = ["undo", "bold", "italic", "read"].map((key) => ({ key }));

describe("arrangeTools", () => {
  it("follows the saved order, puts new tools last and leaves hidden ones out", () => {
    const layout = { order: ["read", "undo"], hidden: ["italic"] };
    expect(arrangeTools(tools, layout).map((t) => t.key)).toEqual(["read", "undo", "bold"]);
    expect(arrangeTools(tools, layout, true).map((t) => t.key)).toEqual(["read", "undo", "bold", "italic"]);
  });
});

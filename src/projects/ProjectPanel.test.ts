// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { foldedTasks, setFoldedTasks } from "./ProjectPanel";

describe("project task list fold", () => {
  it("is remembered per page", () => {
    localStorage.clear();
    expect(foldedTasks("a")).toBe(false);
    setFoldedTasks("a", true);
    expect(foldedTasks("a")).toBe(true);
    expect(foldedTasks("b")).toBe(false);
    setFoldedTasks("a", false);
    expect(foldedTasks("a")).toBe(false);
  });
});

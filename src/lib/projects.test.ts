import { describe, expect, it } from "vitest";
import { extractTasks, projectTag, projectTasks, setTaskChecked } from "./projects";

const task = (text: string, checked = false, sub?: object[]) => ({
  type: "taskItem",
  attrs: { checked },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...(sub ? [{ type: "taskList", content: sub }] : [])],
});
const doc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "plan" }] },
    { type: "taskList", content: [task("draft spec [[Project X]]"), task("buy milk", true, [task("oat #project-x")])] },
  ],
};

describe("projects", () => {
  it("makes a tag from a project name", () => {
    expect(projectTag(" Project X ")).toBe("project-x");
    expect(projectTag("Gym & Health 2026")).toBe("gym-health-2026");
  });

  it("finds every task with where it is", () => {
    expect(extractTasks(doc)).toEqual([
      { path: [1, 0], checked: false, text: "draft spec [[Project X]]" },
      { path: [1, 1], checked: true, text: "buy milk" },
      { path: [1, 1, 1, 0], checked: false, text: "oat #project-x" },
    ]);
  });

  it("rolls up tasks that link to or tag the project", () => {
    expect(projectTasks(doc, "project x").map((t) => t.text)).toEqual(["draft spec [[Project X]]", "oat #project-x"]);
  });

  it("ticks one task without touching the rest", () => {
    const next = setTaskChecked(doc, [1, 1, 1, 0], true);
    expect(extractTasks(next).map((t) => t.checked)).toEqual([false, true, true]);
    expect(extractTasks(doc).map((t) => t.checked)).toEqual([false, true, false]);
  });
});

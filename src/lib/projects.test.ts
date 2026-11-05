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

  it("counts tasks inside the project's box in a day note", () => {
    const day = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "morning" }] },
        { type: "paragraph", attrs: { indent: 0 }, content: [{ type: "text", text: "[[Journal]]" }] },
        { type: "taskList", attrs: { indent: 1 }, content: [task("write 3 pages"), task("review", true)] },
        { type: "paragraph", attrs: { indent: 1 }, content: [{ type: "text", text: "notes" }] },
        { type: "taskList", attrs: { indent: 0 }, content: [task("not this one")] },
      ],
    };
    expect(projectTasks(day, "Journal").map((t) => t.text)).toEqual(["write 3 pages", "review"]);
  });

  it("counts tasks under a heading that names the project, and sub-tasks of a task that does", () => {
    const day = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "#journal today" }] },
        { type: "taskList", content: [task("under heading")] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Other" }] },
        { type: "taskList", content: [task("elsewhere"), task("big [[Journal]]", false, [task("small step")])] },
      ],
    };
    expect(projectTasks(day, "Journal").map((t) => t.text)).toEqual(["under heading", "big [[Journal]]", "small step"]);
  });
});

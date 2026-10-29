import { describe, expect, it } from "vitest";
import { appendLogLine, chatMessages } from "./chat";

describe("chat journaling", () => {
  it("adds messages as log lines, continuing the log at the end", () => {
    const start = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "morning notes" }] }] };
    const one = appendLogLine(start, "coffee ☕", new Date(2026, 9, 28, 8, 5, 0));
    const two = appendLogLine(one, " walked to work ", new Date(2026, 9, 28, 9, 30, 0));
    expect(two.content?.map((b) => b.type)).toEqual(["paragraph", "bulletList"]);
    expect(chatMessages(two)).toEqual([
      { time: "08:05", text: "coffee ☕" },
      { time: "09:30", text: "walked to work" },
    ]);
  });

  it("starts a new log after other writing", () => {
    const one = appendLogLine(null, "a", new Date(2026, 9, 28, 8, 0, 0));
    const withText = { ...one, content: [...one.content!, { type: "paragraph", content: [{ type: "text", text: "thoughts" }] }] };
    expect(appendLogLine(withText, "b", new Date(2026, 9, 28, 9, 0, 0)).content?.map((b) => b.type)).toEqual(["bulletList", "paragraph", "bulletList"]);
  });
});

import { describe, expect, it } from "vitest";
import { looseJson, transcriptText, turnBlocks } from "./talk";

describe("talking journal", () => {
  it("reads a small model's loose JSON", () => {
    expect(looseJson('Sure! ```json\n{"reflection":"r","question":"q?"}\n```')).toEqual({ reflection: "r", question: "q?" });
    expect(looseJson("no json")).toBeNull();
  });
  it("note lines: English first, Gujarati under it as a quiet comment", () => {
    const b = turnBlocks([{ by: "ai", text: "How was your day?", gu: "દિવસ કેવો રહ્યો?" }, { by: "me", text: "Good", gu: "સારો" }], "call");
    expect(b.map((x) => x.content?.[0]?.text)).toEqual(["📞 How was your day?", "ગુ: દિવસ કેવો રહ્યો?", "💬 Good", "ગુ: સારો"]);
    expect(b[1].attrs).toEqual({ indent: 1 });
    expect(b[1].content?.[0]?.marks).toEqual([{ type: "italic" }]);
  });
  it("interview: reflection before the next question", () => {
    const b = turnBlocks([{ by: "ai", text: "Why?", reflect: "Seneca would say…" }], "interview");
    expect(b.map((x) => x.content?.[0]?.text)).toEqual(["🪞 Seneca would say…", "❓ Why?"]);
    expect(transcriptText([{ by: "ai", text: "Q" }, { by: "me", text: "A" }])).toBe("Interviewer: Q\nHapi: A");
  });
});

import { describe, expect, it } from "vitest";
import { chatml, restMs, splitThinking } from "./local";
import { parseToolCalls } from "./agent";
import { replaceInDoc } from "../mcp";

describe("local model", () => {
  it("writes ChatML and splits thinking", () => {
    expect(chatml([{ role: "user", content: "hi" }], true)).toBe("<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n<think>\n");
    expect(splitThinking("hmm\n</think>\n\nHello", true)).toEqual({ thinking: "hmm", answer: "Hello" });
    expect(splitThinking("still thinking", true).answer).toBe("");
  });
  it("rests longer when the chip slows down", () => {
    expect(restMs("off", 8000, 20, 20)).toBe(0);
    expect(restMs("cool", 8000, 20, 20)).toBe(8000);
    expect(restMs("cool", 8000, 14, 20)).toBe(16000);
    expect(Math.round(restMs("cold", 8000, 10, 20))).toBe(48727);
  });
  it("finds tool calls", () => {
    const r = parseToolCalls('Sure.\n<tool_call>\n{"name": "append", "arguments": {"text": "x"}}\n</tool_call>');
    expect(r.calls).toEqual([{ name: "append", arguments: { text: "x" } }]);
    expect(r.text).toBe("Sure.");
  });
  it("replaces text in a note", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "buy " }, { type: "text", text: "milk", marks: [{ type: "bold" }] }] }] };
    expect(replaceInDoc(doc, "milk", "eggs")?.content?.[0].content?.[1]).toEqual({ type: "text", text: "eggs", marks: [{ type: "bold" }] });
    expect(replaceInDoc(doc, "buy milk", "done")?.content?.[0].content).toEqual([{ type: "text", text: "done" }]);
    expect(replaceInDoc(doc, "nope", "x")).toBeNull();
  });
});

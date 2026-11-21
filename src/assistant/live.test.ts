import { describe, expect, it } from "vitest";
import { blockFor, blockPrint, parsePlan, placeBlock } from "./live";
import { PauseChunker, SPEECH_RATE } from "../lib/wav";

describe("live agents", () => {
  it("reads a plan even with a fence or thinking around it", () => {
    const p = parsePlan('<think>x</think>```json\n{"action":"make","headers":["Trait","Cow"],"rows":[["Legs","**4**"]]}\n```');
    expect(p?.action).toBe("make");
    expect(p?.kind).toBe("table");
    expect(p?.rows?.[0][1]).toBe("4");
    expect(parsePlan("no json")).toBeNull();
    expect(parsePlan('{"action":"dance"}')).toBeNull();
  });

  it("makes a table, then a correction replaces it in place", () => {
    const made = blockFor({ action: "make", kind: "table", headers: ["Trait", "Cow", "Dog"], rows: [["Legs", "4", "4"]] })!;
    expect(made.node.type).toBe("sheetBlock");
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] };
    const first = placeBlock(doc, made.node, null).doc;
    expect(first.content?.[1].type).toBe("sheetBlock");
    // The editor adds ids to blocks; the print ignores them.
    const withIds = { ...first, content: first.content!.map((n) => ({ ...n, attrs: { ...(n.attrs ?? {}), lineId: "x1" } })) };
    const fixed = blockFor({ action: "edit", kind: "table", headers: ["Trait", "Dinosaur", "Dog"], rows: [["Legs", "2 or 4", "4"]] })!;
    const r = placeBlock(withIds, fixed.node, blockPrint(made.node));
    expect(r.replaced).toBe(true);
    expect(r.doc.content?.filter((n) => n.type === "sheetBlock")).toHaveLength(1);
    expect(String(r.doc.content?.[1].attrs?.data)).toContain("Dinosaur");
    const gone = placeBlock(r.doc, null, blockPrint(fixed.node));
    expect(gone.doc.content?.some((n) => n.type === "sheetBlock")).toBe(false);
  });

  it("lists and one-liners", () => {
    expect(blockFor({ action: "make", kind: "list", lines: ["a", "b"] })?.node.type).toBe("bulletList");
    expect(blockFor({ action: "make", kind: "text", lines: ["hello"] })?.node.type).toBe("paragraph");
    expect(blockFor({ action: "make" })).toBeNull();
  });

  it("cuts talk at each pause, never hands out silence", () => {
    const got: number[] = [];
    const c = new PauseChunker((s) => got.push(s.length / SPEECH_RATE));
    const tone = (sec: number, amp: number) => Float32Array.from({ length: Math.round(sec * SPEECH_RATE) }, (_, i) => amp * Math.sin(i / 3));
    c.push(tone(4, 0));
    expect(got).toHaveLength(0);
    c.push(tone(1.2, 0.2));
    c.push(tone(0.9, 0));
    expect(got).toHaveLength(1);
    c.push(tone(0.8, 0.2));
    c.flush();
    expect(got).toHaveLength(2);
  });

  it("hears pauses in a noisy room (the bar rises with the room's own sound)", () => {
    const got: number[] = [];
    const c = new PauseChunker((s) => got.push(s.length / SPEECH_RATE));
    const noise = (sec: number, amp: number) => Float32Array.from({ length: Math.round(sec * SPEECH_RATE) }, (_, i) => amp * Math.sin(i / 3) + 0.02 * Math.sin(i / 7));
    // A fan louder than the fixed bar (0.012) the whole time.
    c.push(noise(3, 0));
    expect(got).toHaveLength(0);
    c.push(noise(1.2, 0.25));
    c.push(noise(1, 0));
    expect(got).toHaveLength(1);
  });
});

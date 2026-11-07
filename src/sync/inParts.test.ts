import { describe, expect, it } from "vitest";
import { inParts } from "./engine";
import type { SyncRecord } from "./engine";

const rec = (id: string, size: number) => ({ event: { id, after: { text: "x".repeat(size) } } }) as unknown as SyncRecord;

describe("inParts", () => {
  it("splits a backlog into parts under the limit, keeping order", () => {
    const parts = inParts([rec("a", 400), rec("b", 400), rec("c", 400), rec("d", 2000)], 1000);
    expect(parts.map((p) => p.map((r) => r.event.id))).toEqual([["a", "b"], ["c"], ["d"]]);
  });
  it("keeps everything in one part when small", () => {
    expect(inParts([rec("a", 10), rec("b", 10)], 1000)).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import type { JournalEvent } from "../store";
import { buildNexus } from "./nexus";

const ev = (id: string, device: string, at: string, parents: string[], op: JournalEvent["op"] = "update"): JournalEvent => ({
  id, deviceId: device, actor: "me", blockId: "day:2026-10-28", op, before: null, after: "{}", parentEventIds: parents, createdAt: at,
});

describe("buildNexus", () => {
  it("puts each device in its own lane and marks concurrent edits", () => {
    const n = buildNexus([
      ev("a", "phone", "2026-10-28T10:00:00Z", [], "create"),
      ev("b", "phone", "2026-10-28T10:05:00Z", ["a"]),
      ev("c", "mac", "2026-10-28T10:06:00Z", ["a"]),
      ev("p", "phone", "2026-10-28T10:07:00Z", ["b"], "props"),
      ev("d", "phone", "2026-10-28T10:10:00Z", ["b"]),
    ]);
    expect(n.devices).toEqual(["phone", "mac"]);
    expect(n.nodes.map((x) => [x.event.id, x.lane, x.concurrent])).toEqual([["a", 0, false], ["b", 0, true], ["c", 1, true], ["d", 0, false]]);
    expect(n.edges).toEqual([{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }]);
    expect(n.conflicts).toBe(1);
  });

  it("has no conflicts for one device's straight line", () => {
    const n = buildNexus([ev("a", "phone", "1", []), ev("b", "phone", "2", ["a"])]);
    expect(n.conflicts).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { coalesce } from "./coalesce";

describe("coalesce", () => {
  it("runs again once when called during a run", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const job = coalesce(async () => {
      runs++;
      if (runs === 1) await new Promise<void>((r) => (release = r));
    });
    const first = job();
    void job();
    void job();
    release();
    await first;
    expect(runs).toBe(2);
  });

  it("runs every time when calls don't overlap", async () => {
    let runs = 0;
    const job = coalesce(async () => void runs++);
    await job();
    await job();
    expect(runs).toBe(2);
  });
});

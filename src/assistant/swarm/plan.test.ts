import { describe, expect, it } from "vitest";
import { kindOf, planSwarm, rng, type PieceHint } from "./plan";

describe("agent swarm plan", () => {
  it("picks the kind from the tool, then from the block", () => {
    expect(kindOf({ tool: "math_add" })).toBe("math");
    expect(kindOf({ tool: "add_table" })).toBe("table");
    expect(kindOf({ shape: "DIV code-block" })).toBe("code");
    expect(kindOf({ shape: "UL" })).toBe("list");
    expect(kindOf({ shape: "DIV" }, ["plot", "plot", "head"])).toBe("chart");
    expect(kindOf({ shape: "P" }, ["line"])).toBe("text");
  });

  it("sends the agents each part needs, and every part gets built", () => {
    const hints: PieceHint[] = ["formula", "line", "line", "line", "result", "plot"];
    const p = planSwarm({ tool: "math_solve" }, hints, rng(7));
    const roles = p.agents.map((a) => a.role);
    expect(roles).toContain("Parser");
    expect(roles).toContain("Solver");
    expect(new Set(p.steps.map((s) => s.piece)).size).toBe(hints.length);
    expect(p.steps.find((s) => hints[s.piece] === "plot")?.act).toBe("draw");
  });

  it("lasts about two to three seconds and differs between runs", () => {
    const hints: PieceHint[] = ["head", "cell", "cell", "cell", "cell", "cell", "cell"];
    const a = planSwarm({ tool: "add_table" }, hints, rng(1));
    const b = planSwarm({ tool: "add_table" }, hints, rng(99));
    for (const p of [a, b]) {
      expect(p.totalMs).toBeGreaterThanOrEqual(2000);
      expect(p.totalMs).toBeLessThanOrEqual(3100);
      for (const s of p.steps) expect(s.at + s.dur).toBeLessThanOrEqual(p.buildMs);
      expect(p.agents.length).toBeGreaterThanOrEqual(2);
      expect(p.agents.length).toBeLessThanOrEqual(4);
    }
    expect(JSON.stringify(a.steps)).not.toBe(JSON.stringify(b.steps));
  });

  it("brings more agents for a bigger block", () => {
    const small = planSwarm({ shape: "P" }, ["line"], () => 0.9);
    const big = planSwarm({ shape: "P", text: "x".repeat(300) }, Array(12).fill("line") as PieceHint[], () => 0.9);
    expect(big.agents.length).toBeGreaterThan(small.agents.length);
  });
});

import { describe, expect, it } from "vitest";
import type { AiRequest } from "./client";
import {
  applyAsk,
  applyCrit,
  answer,
  conversationMd,
  freshSession,
  mergePrompt,
  queueQuestion,
  send,
  setAsk,
  setStudio,
  start,
  studio,
  toReview,
  togglePoint,
  undo,
  writeDraft,
  merge,
  type Session,
} from "./promptStudio";

describe("prompt studio", () => {
  it("asks, takes answers, places the second opinion before the open question, and undoes", () => {
    let s: Session = { ...freshSession(), phase: "interview", brief: "Pocket wallet" };
    s = applyAsk(s, { question: "What counts as done?", why: "w", suggestions: ["a", "b"], topic: "goal", covered: [], gaps: ["scope"], done: false }, "Gemini");
    expect(s.pending?.q).toBe("What counts as done?");
    s = answer(s, "Balance updates");
    expect(s.qa).toEqual([{ q: "What counts as done?", topic: "goal", a: "Balance updates" }]);
    s = applyAsk(s, { question: "Which currency?", topic: "money", done: false }, "Gemini");
    s = applyCrit(s, { comment: "Refunds?", kind: "gap", askAlso: "What about refunds?" }, "Local (qwen3)");
    expect(s.log.map((m) => m.who)).toEqual(["ai", "me", "crit", "ai"]);
    const u = undo(s);
    expect(u.text).toBe("Balance updates");
    expect(u.s.qa).toHaveLength(0);
    expect(u.s.pending?.q).toBe("What counts as done?");
    expect(u.s.log.map((m) => m.who)).toEqual(["ai"]);
  });

  it("ends when the Interviewer says done, and later notes reopen it", () => {
    let s = applyAsk(freshSession(), { question: "", done: true }, "Gemini");
    expect(s.done).toBe(true);
    s = answer(s, "Also works offline");
    expect(s.done).toBe(false);
    expect(s.qa[0].q).toBe("Extra note");
  });

  it("review points: join ticked, keep-out unticked, merge prompt lists both", () => {
    const r = toReview({ summary: "x", points: [{ title: "Refunds", verdict: "join", why: "gap", text: "Handle refunds" }, { title: "Crypto", verdict: "dont", why: "scope", text: "" }] }, "Gemini");
    expect(r.points.map((p) => p.on)).toEqual([true, false]);
    const p = mergePrompt({ ...freshSession(), draft: "DRAFT", review: r });
    expect(p).toContain("- Refunds: Handle refunds");
    expect(p).toMatch(/REJECTED \(keep out\):\n- Crypto/);
    expect(p).toContain("DRAFT");
  });

  it("runs the whole flow with the chosen AIs and copies the conversation", async () => {
    const seen: string[] = [];
    let n = 0;
    setAsk(async <T,>(req: AiRequest) => {
      seen.push(`${req.task}:${req.provider}`);
      const t = req.text;
      const json = t.startsWith("You are the Interviewer")
        ? ++n > 1 ? { done: true } : { question: "Who uses it?", topic: "users", suggestions: ["me"], covered: ["goal"], gaps: [], done: false }
        : t.startsWith("You are the Second Opinion, a different")
          ? { comment: "Think about cash from ATM", kind: "idea", askAlso: "ATM withdrawals?" }
          : t.startsWith("You are the Second Opinion")
            ? { summary: "close", agreements: ["pocket"], points: [{ title: "ATM", verdict: "join", why: "w", text: "Log ATM cash" }], comments: [], scores: { clarity: 8 } }
            : null;
      const text = t.startsWith("Write the final") ? "DRAFT" : t.startsWith("Revise") ? "FINAL" : JSON.stringify(json);
      return { text, json: json as T, actor: req.provider === "local" ? "Local (qwen3)" : "Gemini" };
    });
    setStudio(freshSession());
    await start({ brief: "Pocket", target: "a coding agent", depth: 6, persona: "skeptic", live: true, asker: "gemini", critic: "local" });
    expect(studio().pending?.q).toBe("Who uses it?");
    await send("Just me");
    expect(studio().done).toBe(true);
    const i = studio().log.findIndex((m) => m.who === "crit");
    queueQuestion(i);
    expect(studio().extra).toEqual(["ATM withdrawals?"]);
    await writeDraft();
    expect(studio().draft).toBe("DRAFT");
    expect(studio().review?.by).toBe("Local (qwen3)");
    togglePoint(0, true);
    await merge();
    expect(studio().final).toBe("FINAL");
    expect(studio().busy).toEqual([]);
    expect(seen).toContain("describe:local");
    expect(seen).toContain("organise:local");
    const md = conversationMd(studio());
    expect(md).toContain("**You:** Just me");
    expect(md).toContain("Second opinion (Local (qwen3)) · idea");
    expect(md).toContain("## Final prompt");
  });

  it("an Interviewer failure shows an error and leaves the busy list empty", async () => {
    setAsk(async () => {
      throw new Error("Gemini rate limit reached");
    });
    setStudio(freshSession());
    await start({ brief: "x", target: "t", depth: 6, persona: "p", live: false, asker: "gemini", critic: "gemini" });
    expect(studio().error).toContain("rate limit");
    expect(studio().busy).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  calibrateState,
  choiceGraph,
  engineData,
  engineRecords,
  entryKey,
  isInternalPage,
  KEEP_RUNS,
  looseJson,
  normalizeAnalysis,
  normalizeCalibration,
  overlap,
  parseRecords,
  rawSignals,
  recordsDoc,
  safeJson,
  similarFailed,
  situationContext,
  situationMarkdown,
  situationStats,
  type EngineRec,
  type Entry,
  type MoveRec,
  type RunRec,
} from "./consequence";
import { extractLinks } from "./links";
import { docText } from "./words";
import { mindMapFromGraph } from "./graphFormat";

const entry = (day: string, raw: string, hour?: number): Entry => ({ day, raw, key: entryKey(day, raw), hour });
const move = (p: Partial<MoveRec>): MoveRec => ({ kind: "move", id: "m1", at: "2026-11-01T10:00:00Z", day: "2026-11-01", path: "B", action: "Ask Ravi for the payment in writing", predicted: { immediate: "He delays", months: "Paid late" }, checkDay: "2026-11-08", ...p });
const analysis = {
  summary: "You are owed money and keep asking nicely.",
  stress: { level: 72, reading: "Rushed, angry." },
  loops: [{ pattern: "Asking by phone again", when: "March, June", warning: "Phone asks failed twice." }],
  sunkCost: { meter: 64, call: "reassess", why: "A year in, 20% paid." },
  lenses: { mine: "I'm being cheated.", theirs: "Cash is tight.", observer: "No written terms.", blindSpot: "You never set a deadline." },
  paths: [
    { id: "A", style: "hold", title: "Wait", action: "Wait a month", immediate: "Nothing", counter: "Relief", months: "Still unpaid", longRun: "Written off", risk: "low", odds: 20, cost: "time" },
    { id: "B", style: "strategic", title: "Written terms", action: "Send written terms with a date", immediate: "He objects", counter: "Negotiates", months: "Paid in parts", longRun: "Clean exit", risk: "medium", odds: 65, cost: "awkward talk" },
    { id: "D", style: "exit", title: "Cut losses", action: "Stop the project", immediate: "Relief", counter: "Surprise", months: "Free time", longRun: "Lesson", risk: "low", odds: 50, cost: "the money" },
  ],
  verdict: { path: "B", text: "Put it in writing." },
  state: { goal: "Get paid", summary: "Owed money.", people: [{ name: "Ravi", patterns: ["delays when asked by phone"] }], leverage: "Contract", blindSpots: ["no deadline"], keyEvents: ["2026-03: first delay"], failedMoves: [], lessons: [] },
};

describe("consequence engine: records", () => {
  it("round-trips through a page, never as links or tags, one line id per record", () => {
    const recs: EngineRec[] = [
      { kind: "fact", id: "f1", at: "2026-11-01T00:00:00Z", q: "What did [[Ravi]] say?", a: "He said #later" },
      move({ action: "Call [[Ravi]] #money" }),
    ];
    const doc = recordsDoc(recs);
    expect(extractLinks(docText(doc as never))).toEqual({ wikilinks: [], tags: [] });
    expect(doc.content.map((b) => b.attrs.lid)).toEqual(["ce-fact-f1", "ce-move-m1"]);
    const back = parseRecords<EngineRec>(doc as never);
    expect(back).toEqual(recs);
    expect(safeJson({ a: "[[x]] #y" })).not.toMatch(/\[\[|#/);
  });

  it("skips unreadable blocks and keeps the newest runs only", () => {
    const run = (i: number): RunRec => ({ kind: "run", id: `r${i}`, at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`, by: "Gemini", model: "m", entries: 1, analysis: normalizeAnalysis(analysis).analysis });
    const doc = recordsDoc([...Array.from({ length: KEEP_RUNS + 3 }, (_, i) => run(i))]);
    (doc.content as unknown[]).push({ type: "codeBlock", content: [{ type: "text", text: "{broken" }] }, { type: "paragraph", content: [{ type: "text", text: "hi" }] });
    const d = engineData(parseRecords<EngineRec>(doc as never));
    expect(d.runs).toHaveLength(KEEP_RUNS + 3);
    const kept = engineRecords(d).filter((r) => r.kind === "run");
    expect(kept).toHaveLength(KEEP_RUNS);
    expect(kept[kept.length - 1].id).toBe(`r${KEEP_RUNS + 2}`);
  });

  it("knows the app's own pages", () => {
    expect(isInternalPage("Consequence engine · Ravi")).toBe(true);
    expect(isInternalPage("Graph · Ravi choices")).toBe(true);
    expect(isInternalPage("Ravi")).toBe(false);
  });
});

describe("consequence engine: raw signals", () => {
  it("is calm for calm writing", () => {
    expect(rawSignals("Met Ravi today. We agreed on the next payment date, which feels fair.").score).toBe(0);
  });
  it("counts doubled words, capitals, !!, stretched words and late nights", () => {
    const s = rawSignals("i cant believe he he did this AGAIN!! WHY does he never listen?? sooo tired i want to quit", 2);
    expect(s.score).toBeGreaterThan(60);
    expect(s.notes.join(" ")).toMatch(/doubled/);
    expect(s.notes.join(" ")).toMatch(/capitals/);
    expect(s.notes.join(" ")).toMatch(/late night/);
  });
});

describe("consequence engine: context", () => {
  it("keeps the newest entries whole and digests older ones within the budget", () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(`2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`, `Entry ${i} `.repeat(40)));
    const text = situationContext({ title: "Ravi", today: "2026-11-14", page: "Client project", entries, clean: new Map(), data: { state: null, runs: [], facts: [], moves: [move({ outcome: { at: "x", text: "He paid half", felt: "worse", match: 30 } })] }, now: "He called again", budget: 12_000 });
    expect(text.length).toBeLessThanOrEqual(12_500);
    expect(text).toContain("Entry 59");
    expect(text).toContain("Older entries");
    expect(text).toContain("REALLY: He paid half");
    expect(text).toContain("Right now (Hapi just wrote this)\nHe called again");
    expect(text).toMatch(/oldest entr(y is|ies are) left out/);
  });
});

describe("consequence engine: answers", () => {
  it("normalises a model's answer and fills gaps", () => {
    const { analysis: a, state } = normalizeAnalysis({ ...analysis, paths: [{ id: "x", action: "Do it", odds: 150, risk: "extreme" }, { id: "A", action: "Wait" }], verdict: { path: "Z" } });
    expect(a.paths.map((p) => p.id)).toEqual(["A", "B"]);
    expect(a.paths[1]).toMatchObject({ odds: 100, risk: "medium", title: "Strategic move" });
    expect(a.verdict.path).toBe("A");
    expect(state?.people[0].name).toBe("Ravi");
    expect(normalizeAnalysis(null).analysis.paths).toEqual([]);
  });

  it("reads JSON wrapped in thinking and fences", () => {
    expect(looseJson('<think>hmm {no}</think>```json\n{"a": [1, 2,],}\n```')).toEqual({ a: [1, 2] });
    expect(looseJson("no json")).toBeNull();
  });

  it("calibrates: lesson, failed move and the person's pattern go into the state", () => {
    const cal = normalizeCalibration({ match: 140, lesson: "Ravi only moves with a date", failed: true, people: [{ name: "ravi", pattern: "ignores calls" }, { name: "", pattern: "x" }] });
    expect(cal.match).toBe(100);
    const s = calibrateState(normalizeAnalysis(analysis).state, move({}), cal);
    expect(s.lessons[0]).toContain("Ravi only moves with a date");
    expect(s.failedMoves[0]).toContain("Ask Ravi");
    expect(s.people).toHaveLength(1);
    expect(s.people[0].patterns).toEqual(["delays when asked by phone", "ignores calls"]);
  });
});

describe("consequence engine: reality loop", () => {
  it("stats: days, pending, due and accuracy", () => {
    const st = situationStats([entry("2026-11-01", "a b c"), entry("2026-11-10", "d e f")], [move({ outcome: { at: "x", text: "y", felt: "worse", match: 40 } }), move({ id: "m2", checkDay: "2026-11-20" }), move({ id: "m3", checkDay: "2026-11-12" })], "2026-11-14");
    expect(st).toMatchObject({ firstDay: "2026-11-01", days: 14, entries: 2, logged: 1, accuracy: 40, pending: 2, due: 1 });
  });

  it("warns when a path looks like a move that went worse", () => {
    const failed = move({ action: "Call Ravi and ask for the payment again", outcome: { at: "x", text: "ignored", felt: "worse" } });
    expect(overlap("Call Ravi and ask for payment", failed.action)).toBeGreaterThan(0.5);
    expect(similarFailed("Phone Ravi and ask for the payment", [failed])).toHaveLength(1);
    expect(similarFailed("Send written terms with a deadline", [failed])).toHaveLength(0);
  });
});

describe("consequence engine: outputs", () => {
  it("makes a graph Canvas and the mind map open", () => {
    const a = normalizeAnalysis(analysis).analysis;
    const g = choiceGraph("Ravi", a, new Date(2026, 10, 14));
    expect(g.features.map((f) => f.label)).toEqual(["A · Wait", "B · Written terms ★", "D · Cut losses"]);
    expect(g.prompts).toHaveLength(3);
    expect(mindMapFromGraph(g, "Ravi").nodes.length).toBeGreaterThan(10);
  });

  it("writes a Markdown summary for AI tools and exports", () => {
    const a = normalizeAnalysis(analysis);
    const md = situationMarkdown("Ravi", {
      state: { kind: "state", id: "state", at: "2026-11-14T00:00:00Z", ...a.state! },
      runs: [{ kind: "run", id: "r", at: "2026-11-14T00:00:00Z", by: "Gemini", model: "gemini-3.1-pro-preview", entries: 3, analysis: a.analysis }],
      facts: [],
      moves: [move({})],
    });
    expect(md).toContain("Verdict: path B");
    expect(md).toContain("Ravi: delays when asked by phone");
    expect(md).toContain("waiting (check 2026-11-08)");
  });
});

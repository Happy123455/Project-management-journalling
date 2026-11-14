// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { docText } from "../lib/words";
import { ANALYSIS_SCHEMA, CALIBRATE_SCHEMA, CLEAN_SCHEMA, cleanPage, enginePage, nowLine } from "../lib/consequence";
import type { AiAnswer, AiRequest } from "../ai/client";
import { answerQuestions, stopReading, cleanAll, clearJob, defaultDeps, jobFor, loadClean, loadEngine, loadEntries, lockIn, logOutcome, removeMove, startReading, type Deps } from "./engine";
import { runJournalTool } from "../ai/journalTools";
import { buildProjectExport } from "../lib/projectExport";
import { dayKey } from "../lib/timestamp";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...lines: string[]) => ({ type: "doc", content: lines.map(p) }) as never;

const ANALYSIS = {
  summary: "Ravi owes you money; asking by phone hasn't worked.",
  stress: { level: 70, reading: "Angry and tired." },
  loops: [{ pattern: "Calling again", when: "2026-11-01", warning: "That failed before." }],
  sunkCost: { meter: 40, call: "reassess", why: "Half is paid." },
  lenses: { mine: "Cheated.", theirs: "Short of cash.", observer: "No written deadline.", blindSpot: "You never set a date." },
  paths: [
    { id: "A", style: "hold", title: "Wait", action: "Wait two weeks", immediate: "Nothing", counter: "Relief", months: "Still unpaid", longRun: "Written off", risk: "low", odds: 20, cost: "time" },
    { id: "B", style: "strategic", title: "Written terms", action: "Email Ravi the remaining amount with a due date", immediate: "He replies with excuses", counter: "Offers a part payment", months: "Paid in two parts", longRun: "Clean finish", risk: "medium", odds: 65, cost: "an awkward email" },
    { id: "C", style: "direct", title: "Stop work", action: "Pause the work until paid", immediate: "He gets angry", counter: "Threatens to leave", months: "Paid or lost client", longRun: "Respect", risk: "high", odds: 45, cost: "the client" },
  ],
  verdict: { path: "B", text: "Put the amount and the date in writing." },
  state: { goal: "Get paid", summary: "Owed money by Ravi.", people: [{ name: "Ravi", patterns: ["delays when asked by phone"] }], leverage: "The work", blindSpots: ["no deadline"], keyEvents: ["2026-11-01 first delay"], failedMoves: [], lessons: [] },
};

function fakeDeps(over: Partial<Deps> = {}) {
  const asked: AiRequest[] = [];
  const answer = (req: AiRequest, json: unknown): AiAnswer => ({ text: JSON.stringify(json), json, actor: "Gemini", model: req.task === "organise" ? "gemini-3.1-pro-preview" : "gemini-3.8-flash", provider: "gemini" });
  const deps: Deps = {
    ...defaultDeps,
    provider: async () => "gemini",
    now: () => new Date(2026, 10, 14, 10, 0, 0),
    ask: async (req) => {
      asked.push(req);
      if (req.schema === CLEAN_SCHEMA) {
        const n = (req.text.match(/^\[\d+\] /gm) ?? []).length;
        const asking = !req.text.includes("No pre-flight");
        return answer(req, { entries: Array.from({ length: n }, (_, i) => ({ i, clean: `Clean copy ${i}.`, stress: 55, tone: "angry" })), ready: !asking, questions: asking ? ["What exactly did Ravi promise, and when?"] : [] });
      }
      if (req.schema === ANALYSIS_SCHEMA) return answer(req, ANALYSIS);
      if (req.schema === CALIBRATE_SCHEMA) return answer(req, { match: 30, surprise: "He paid nothing", lesson: "Ravi ignores emails too", failed: true, people: [{ name: "Ravi", pattern: "ignores emails" }] });
      throw new Error("unexpected request");
    },
    ...over,
  };
  return { deps, asked };
}

async function journal() {
  const store = new MemoryStore();
  const ravi = await store.ensurePage("Ravi");
  await store.savePage({ id: ravi.id, content: doc("Client. Website project, ₹80k."), plainText: "Client. Website project, ₹80k." });
  for (const [day, text] of [
    ["2026-11-01", "[[Ravi]] said hed pay by friday. i called him him twice, nothing!!"],
    ["2026-11-08", "[[Ravi]] paid half. still owes 40k"],
    ["2026-11-12", "groceries"],
  ]) await store.saveDay({ day, content: doc(text), plainText: text });
  return store;
}

const today = "2026-11-14";

describe("consequence engine: a reading", () => {
  beforeEach(() => {
    clearJob("Ravi");
    localStorage.clear();
  });

  it("saves 'now' to today's note, cleans, asks, then reads with the answers", async () => {
    const store = await journal();
    const { deps, asked } = fakeDeps();
    const saved = await startReading(store, "Ravi", { pageText: "Client.", now: "He called again asking for more time", choice: "auto" }, deps);
    expect(saved).toBe(true);
    expect(docText((await store.getDay(today))!.content)).toContain(nowLine("Ravi", "He called again asking for more time"));
    // The note itself is untouched; clean copies live on their own page.
    expect(docText((await store.getDay("2026-11-01"))!.content)).toBe("[[Ravi]] said hed pay by friday. i called him him twice, nothing!!");
    const entries = await loadEntries(store, "Ravi");
    expect(entries.map((e) => e.day)).toEqual(["2026-11-01", "2026-11-08", today]);
    const clean = await loadClean(store, "Ravi");
    expect(clean.size).toBe(3);
    expect(clean.get(entries[0].key)?.tone).toBe("angry");

    expect(jobFor("Ravi")).toMatchObject({ phase: "asking", questions: ["What exactly did Ravi promise, and when?"] });
    await answerQuestions(store, "Ravi", ["Full payment by 7 Nov, on WhatsApp"], deps);
    expect(jobFor("Ravi")?.phase).toBe("done");

    const d = await loadEngine(store, "Ravi");
    expect(d.facts).toMatchObject([{ q: "What exactly did Ravi promise, and when?", a: "Full payment by 7 Nov, on WhatsApp" }]);
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0]).toMatchObject({ by: "Gemini", model: "gemini-3.1-pro-preview", entries: 3 });
    expect(d.runs[0].analysis.verdict.path).toBe("B");
    expect(d.state?.people[0].name).toBe("Ravi");

    // The deep reading saw the raw text, the answer and "now".
    const deep = asked.find((r) => r.schema === ANALYSIS_SCHEMA)!;
    expect(deep).toMatchObject({ task: "organise", provider: "gemini" });
    expect(deep.text).toContain("i called him him twice");
    expect(deep.text).toContain("Full payment by 7 Nov");
    expect(deep.text).toContain("Right now (Hapi just wrote this)");

    // The engine's pages never count as mentions of Ravi.
    const refs = await store.references("wikilink", "Ravi");
    expect(refs.some((r) => r.title?.startsWith("Consequence"))).toBe(false);
    // AI-written records carry the AI's name (shown and undoable in AI changes).
    expect((await store.aiChanges()).some((c) => c.title === enginePage("Ravi"))).toBe(true);
    expect((await store.getPage(cleanPage("Ravi")))).not.toBeNull();
  });

  it("skipping the questions still reads; a second reading reuses clean copies", async () => {
    const store = await journal();
    const { deps, asked } = fakeDeps();
    await startReading(store, "Ravi", { pageText: "", choice: "auto" }, deps);
    await answerQuestions(store, "Ravi", null, deps);
    expect((await loadEngine(store, "Ravi")).facts).toHaveLength(0);
    expect((await loadEngine(store, "Ravi")).runs).toHaveLength(1);
    await startReading(store, "Ravi", { pageText: "", choice: "auto" }, deps);
    const cleans = asked.filter((r) => r.schema === CLEAN_SCHEMA);
    expect(cleans[1].text).toContain("no entries to clean");
  });

  it("uses the Mac's model in cool bursts and reads JSON out of its thinking", async () => {
    const store = await journal();
    const { deps } = fakeDeps({
      provider: async () => "local",
      local: async (_system, user) => {
        expect(user).toContain('"verdict"');
        return { text: `<think>weighing it</think>\n\`\`\`json\n${JSON.stringify(ANALYSIS)}\n\`\`\``, model: "qwen3:14b" };
      },
    });
    await startReading(store, "Ravi", { pageText: "", choice: "local" }, deps);
    await answerQuestions(store, "Ravi", null, deps);
    expect((await loadEngine(store, "Ravi")).runs[0]).toMatchObject({ by: "Local (qwen3)", model: "qwen3:14b" });
  });

  it("keeps 'now' even when the reading can't run, and says why", async () => {
    const store = await journal();
    const { deps } = fakeDeps({ provider: async () => Promise.reject(new Error("Add a Gemini key")) });
    expect(await startReading(store, "Ravi", { pageText: "", now: "Thinking of quitting", choice: "auto" }, deps)).toBe(true);
    expect(jobFor("Ravi")).toMatchObject({ phase: "error", error: "Add a Gemini key" });
    expect(docText((await store.getDay(today))!.content)).toContain("Thinking of quitting");
  });

  it("asks again without the schema when the provider turns it down", async () => {
    const store = await journal();
    const base = fakeDeps();
    let refused = 0;
    const deps: Deps = {
      ...base.deps,
      ask: async (req) => {
        if (req.schema === ANALYSIS_SCHEMA) {
          refused++;
          throw new Error("Invalid JSON payload received. Unknown name \"enum\" at 'generation_config.response_schema'");
        }
        if (!req.schema && req.task === "organise") {
          expect(req.text).toContain('"sunkCost"');
          return { text: "Here you go:\n" + JSON.stringify(ANALYSIS), json: undefined, actor: "Gemini", model: "gemini-3.1-pro-preview", provider: "gemini" };
        }
        return base.deps.ask(req);
      },
    };
    await startReading(store, "Ravi", { pageText: "", choice: "auto" }, deps);
    await answerQuestions(store, "Ravi", null, deps);
    expect(refused).toBe(1);
    expect((await loadEngine(store, "Ravi")).runs[0].analysis.verdict.path).toBe("B");
  });

  it("drops the answer of a reading that was stopped", async () => {
    const store = await journal();
    const base = fakeDeps();
    let finish: () => void = () => {};
    const deps: Deps = {
      ...base.deps,
      ask: async (req) => {
        if (req.schema === ANALYSIS_SCHEMA) await new Promise<void>((r) => (finish = r));
        return base.deps.ask(req);
      },
    };
    await startReading(store, "Ravi", { pageText: "", choice: "auto" }, deps);
    const going = answerQuestions(store, "Ravi", null, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(jobFor("Ravi")?.phase).toBe("thinking");
    stopReading("Ravi");
    finish();
    await going;
    expect((await loadEngine(store, "Ravi")).runs).toHaveLength(0);
    expect(jobFor("Ravi")).toBeNull();
  });

  it("refuses to read with nothing written", async () => {
    const store = new MemoryStore();
    await store.ensurePage("Nobody");
    const { deps } = fakeDeps();
    expect(await startReading(store, "Nobody", { pageText: "", choice: "auto" }, deps)).toBe(false);
    expect(jobFor("Nobody")?.error).toMatch(/Nothing to read yet/);
    clearJob("Nobody");
  });

  it("cleans the whole backlog in batches", async () => {
    const store = new MemoryStore();
    for (let i = 1; i <= 23; i++) {
      const day = `2026-10-${String(i).padStart(2, "0")}`;
      await store.saveDay({ day, content: doc(`[[Ravi]] note ${i}`), plainText: `[[Ravi]] note ${i}` });
    }
    const { deps, asked } = fakeDeps();
    await cleanAll(store, "Ravi", "auto", deps);
    expect((await loadClean(store, "Ravi")).size).toBe(23);
    expect(asked).toHaveLength(3);
    expect(jobFor("Ravi")).toBeNull();
  });
});

describe("consequence engine: the reality loop", () => {
  it("locks in a move (note line + reminder day), logs what happened and learns from it", async () => {
    const store = await journal();
    const { deps } = fakeDeps();
    await startReading(store, "Ravi", { pageText: "", choice: "auto" }, deps);
    await answerQuestions(store, "Ravi", null, deps);
    const run = (await loadEngine(store, "Ravi")).runs[0];
    const path = run.analysis.paths.find((x) => x.id === "B")!;
    const m = await lockIn(store, "Ravi", { run, path, action: path.action, checkDay: "2026-11-21", remind: true }, deps);
    expect(m).toMatchObject({ path: "B", day: today, checkDay: "2026-11-21", predicted: { odds: 65 } });
    expect(docText((await store.getDay(today))!.content)).toContain("🎲 Locked in: Email Ravi the remaining amount with a due date [[Ravi]]");
    const later = (await store.getDay("2026-11-21"))!;
    expect(docText(later.content)).toContain("🎲 How did it go?");
    expect(later.props.reminder).toBe(true);

    await logOutcome(store, "Ravi", m.id, { text: "He ignored the email completely", felt: "worse", choice: "auto" }, deps);
    const d = await loadEngine(store, "Ravi");
    expect(d.moves[0].outcome).toMatchObject({ text: "He ignored the email completely", felt: "worse", match: 30, failed: true, by: "Gemini" });
    expect(d.state?.lessons.join(" ")).toContain("Ravi ignores emails too");
    expect(d.state?.failedMoves[0]).toContain("Email Ravi");
    expect(d.state?.people[0].patterns).toContain("ignores emails");
    expect(docText((await store.getDay(today))!.content)).toContain("🎲 What happened (worse than predicted): He ignored the email completely [[Ravi]]");

    // The outcome is in the next reading's context.
    const second = fakeDeps();
    await startReading(store, "Ravi", { pageText: "", choice: "auto" }, second.deps);
    await answerQuestions(store, "Ravi", null, second.deps);
    expect(second.asked.find((r) => r.schema === ANALYSIS_SCHEMA)!.text).toContain("REALLY: He ignored the email completely");
  });

  it("keeps the outcome when scoring fails, and removes a move on request", async () => {
    const store = await journal();
    const { deps } = fakeDeps({ provider: async () => Promise.reject(new Error("offline")) });
    const m = await lockIn(store, "Ravi", { action: "Talk to his partner", checkDay: dayKey(new Date(2026, 10, 20)), remind: false }, deps);
    expect(m.path).toBe("custom");
    expect(await store.getDay("2026-11-20")).toBeNull();
    await logOutcome(store, "Ravi", m.id, { text: "Partner promised to help", felt: "better", choice: "auto" }, deps);
    expect((await loadEngine(store, "Ravi")).moves[0].outcome).toMatchObject({ text: "Partner promised to help", felt: "better" });
    await removeMove(store, "Ravi", m.id);
    expect((await loadEngine(store, "Ravi")).moves).toHaveLength(0);
  });

  it("is readable by AI chat tools and in Export for AI", async () => {
    const store = await journal();
    const { deps } = fakeDeps();
    await startReading(store, "Ravi", { pageText: "", choice: "auto" }, deps);
    await answerQuestions(store, "Ravi", null, deps);
    const out = await runJournalTool(store, "read_situation", { title: "ravi" }, "Gemini");
    expect(out?.text).toContain("Verdict: path B");
    expect((await runJournalTool(store, "read_situation", { title: "Nope" }, "Gemini"))?.error).toBe(true);
    const x = await buildProjectExport(store, (await store.getPage("Ravi"))!, []);
    expect(x.consequence).toContain("Path B Written terms");
    // The engine's own pages aren't notes about Ravi.
    expect(x.notes.every((n) => !n.text.includes("Consequence"))).toBe(true);
  });
});

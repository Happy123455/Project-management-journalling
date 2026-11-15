// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { docText } from "../lib/words";
import type { AiAnswer, AiRequest } from "../ai/client";
import { CHECK_SCHEMA, DRILL_SCHEMA, DROPS_PAGE, checkContext, dueDay, normalizeDrill, normalizeDrop, pastLines, similarDrops, stripOwn, type DropRec } from "../lib/oilDrop";
import { answerWhy, defaultDeps, dismissDrop, forgetDrops, loadDrops, maybeRunEvening, openQuestion, remindFix, runCheck, type Deps } from "./oilDrop";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...lines: string[]) => ({ type: "doc", content: lines.map(p) }) as never;

const FOUND = {
  found: true,
  level: "watch",
  confidence: 80,
  symptom: "Your afternoon study block got rushed for the third day running.",
  evidence: [{ day: "2026-11-13", quote: "rushed the study block again" }],
  trap: "Setting another alarm.",
  risk: "The exam chapters pile up into the last week.",
  why: "Why does the study block keep getting squeezed?",
  fix: "Start the block before lunch tomorrow.",
  note: "",
  lastFix: "none",
};

function fakeDeps(check: unknown = FOUND, drill: (req: AiRequest) => unknown = () => ({ done: false, question: "Why do calls run late?", root: "", risk: "", fix: "" })) {
  const asked: AiRequest[] = [];
  const written: { day: string; lines: string[]; actor: string }[] = [];
  const answer = (json: unknown): AiAnswer => ({ text: JSON.stringify(json), json, actor: "Gemini", model: "gemini-3.8-flash", provider: "gemini" });
  const deps: Deps = {
    ...defaultDeps,
    provider: async () => "gemini",
    now: () => new Date(2026, 10, 14, 21, 30, 0),
    ask: async (req) => {
      asked.push(req);
      if (req.schema === CHECK_SCHEMA) return answer(check);
      if (req.schema === DRILL_SCHEMA) return answer(drill(req));
      throw new Error("unexpected");
    },
    appendLines: async (store, day, lines, actor) => {
      written.push({ day, lines, actor });
      const page = await store.getDay(day);
      const content = { type: "doc", content: [...((page?.content as { content?: unknown[] })?.content ?? []), ...lines.map(p)] } as never;
      await store.saveDay({ day, content, plainText: docText(content), actor });
    },
  };
  return { deps, asked, written };
}

const LONG = "Woke late. Calls ran over, so I rushed the study block again and skipped the second chapter. Felt behind all evening. ".repeat(2);

async function journal() {
  const store = new MemoryStore();
  await store.saveDay({ day: "2026-11-12", content: doc("Calls ran long, study block only 20 min."), plainText: "" });
  await store.saveDay({ day: "2026-11-13", content: doc("rushed the study block again"), plainText: "" });
  await store.saveDay({ day: "2026-11-14", content: doc(LONG, "🛢️ Fix: old line the check wrote"), plainText: "" });
  return store;
}

beforeEach(() => {
  forgetDrops();
  localStorage.clear();
});

describe("oil-drop pure parts", () => {
  it("needs confidence and a symptom to warn", () => {
    expect(normalizeDrop(FOUND).found).toBe(true);
    expect(normalizeDrop({ ...FOUND, confidence: 40 }).found).toBe(false);
    const clear = normalizeDrop({ found: false, note: "A normal busy day." });
    expect(clear).toMatchObject({ found: false, symptom: "", why: "", note: "A normal busy day." });
    expect(normalizeDrop(null).note).toBe("All clear.");
  });

  it("finishes a drill only with a root cause", () => {
    expect(normalizeDrill({ done: true, root: "", question: "" }, false).done).toBe(false);
    expect(normalizeDrill({ done: false, question: "Why?", root: "x" }, true)).toMatchObject({ done: true, root: "x" });
  });

  it("reads the day first, leaves out its own lines, and lists past checks", () => {
    expect(stripOwn("a\n🛢️ Fix: b\nc")).toBe("a\nc");
    const rec = { kind: "drop", id: "2026-11-10", day: "2026-11-10", at: "", by: "Gemini", model: "", read: 10, whys: [], dismissed: true, drop: normalizeDrop({ ...FOUND, symptom: "Late nights" }) } as DropRec;
    expect(pastLines([rec], "2026-11-14")[0]).toContain("FALSE ALARM");
    const { text, read } = checkContext({ day: "2026-11-14", days: [{ day: "2026-11-14", text: "today 🙂\n🛢️ x" }, { day: "2026-11-13", text: "yesterday" }], records: [rec], budget: 10_000 });
    expect(read).toBe("today 🙂".length);
    expect(text.indexOf("today 🙂")).toBeLessThan(text.indexOf("yesterday"));
    expect(text).toContain("Late nights");
  });

  it("is due tonight after the hour, else yesterday if missed, never twice", () => {
    const base = { today: "2026-11-14", has: () => false, chars: () => 500, tries: () => 0 };
    expect(dueDay({ ...base, now: new Date(2026, 10, 14, 21, 5), hour: 21 })).toBe("2026-11-14");
    expect(dueDay({ ...base, now: new Date(2026, 10, 14, 9, 0), hour: 21 })).toBe("2026-11-13");
    expect(dueDay({ ...base, now: new Date(2026, 10, 14, 9, 0), hour: 21, has: (d) => d === "2026-11-13" })).toBeNull();
    expect(dueDay({ ...base, now: new Date(2026, 10, 14, 22, 0), hour: 21, chars: (d) => (d === "2026-11-14" ? 20 : 500) })).toBe("2026-11-13");
    expect(dueDay({ ...base, now: new Date(2026, 10, 14, 22, 0), hour: 21, tries: () => 2 })).toBeNull();
  });
});

describe("oil-drop runner", () => {
  it("checks a day, keeps one record per day, and never touches the note", async () => {
    const store = await journal();
    const { deps, asked, written } = fakeDeps();
    const rec = await runCheck(store, "2026-11-14", {}, deps);
    expect(rec?.drop.found).toBe(true);
    expect(asked[0].text).toContain("rushed the study block again");
    expect(asked[0].text).not.toContain("old line the check wrote");
    expect(written).toEqual([]);
    await runCheck(store, "2026-11-14", {}, deps);
    forgetDrops();
    expect((await loadDrops(store)).length).toBe(1);
    const page = await store.getPage(DROPS_PAGE);
    expect(JSON.stringify(page?.content)).toContain("ce-drop-2026-11-14");
  });

  it("drills down with whys, saves each answer first, and writes the root cause in the note", async () => {
    const store = await journal();
    let n = 0;
    const { deps, written } = fakeDeps(FOUND, () => (++n < 2 ? { done: false, question: "Why do calls run late?", root: "", risk: "", fix: "" } : { done: true, question: "", root: "Meetings have no end time.", risk: "Study keeps losing.", fix: "Put an end time on every call invite." }));
    await runCheck(store, "2026-11-14", {}, deps);
    let rec = (await loadDrops(store))[0];
    expect(openQuestion(rec)).toBe(FOUND.why);
    await answerWhy(store, "2026-11-14", "Calls run over.", {}, deps);
    rec = (await loadDrops(store))[0];
    expect(rec.whys).toHaveLength(1);
    expect(openQuestion(rec)).toBe("Why do calls run late?");
    await answerWhy(store, "2026-11-14", "Nobody sets an end time.", {}, deps);
    rec = (await loadDrops(store))[0];
    expect(rec.final?.root).toBe("Meetings have no end time.");
    expect(openQuestion(rec)).toBe("");
    expect(written).toHaveLength(1);
    expect(written[0].actor).toBe("Gemini");
    expect(written[0].lines.join("\n")).toContain("Nobody sets an end time.");
    expect(written[0].lines[written[0].lines.length - 1]).toContain("end time on every call");
    // The fix as a reminder on the next day.
    expect(await remindFix(store, "2026-11-14", deps)).toBe("2026-11-15");
    expect(docText((await store.getDay("2026-11-15"))!.content)).toContain("Today's fix: Put an end time");
  });

  it("keeps Hapi's answer even when the AI fails", async () => {
    const store = await journal();
    const { deps } = fakeDeps(FOUND, () => {
      throw new Error("offline");
    });
    await runCheck(store, "2026-11-14", {}, deps);
    await answerWhy(store, "2026-11-14", "Because of the calls.", {}, { ...deps, ask: async (r) => (r.schema === DRILL_SCHEMA ? Promise.reject(new Error("offline")) : deps.ask(r)) });
    forgetDrops();
    expect((await loadDrops(store))[0].whys[0].a).toBe("Because of the calls.");
  });

  it("all clear and dismissed drops are remembered for later checks", async () => {
    const store = await journal();
    const { deps, asked } = fakeDeps({ found: false, note: "Normal day." });
    expect((await runCheck(store, "2026-11-13", {}, deps))?.drop.found).toBe(false);
    const { deps: d2 } = fakeDeps();
    await runCheck(store, "2026-11-12", {}, d2);
    await dismissDrop(store, "2026-11-12");
    await runCheck(store, "2026-11-14", {}, deps);
    expect(asked[asked.length - 1].text).toContain("FALSE ALARM");
    const recs = await loadDrops(store);
    expect(similarDrops(recs, { ...recs[0], day: "2026-11-20", id: "2026-11-20" }).length).toBe(1);
  });

  it("the evening timer runs once for the due day", async () => {
    const store = await journal();
    const { deps, asked } = fakeDeps();
    expect((await maybeRunEvening(store, deps))?.day).toBe("2026-11-14");
    expect(await maybeRunEvening(store, deps)).toBeNull();
    expect(asked).toHaveLength(2 - 1);
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { setKey } from "../ai/secrets";
import { saveAiSettings, DEFAULT_SETTINGS } from "../ai/settings";
import { addDays, dayKey } from "../lib/timestamp";
import { docText } from "../lib/words";
import { dayLines, shortDay } from "./agentDays";
import { normalizeRows, blockFor } from "./live";
import { FloatingAgent, stageFor, summaryOf } from "./liveAgent";
import { smallDelete } from "./agentTools";
import { liveSchema } from "../talk/geminiLive";

/** A pretend Gemini Live server: answers each request with the calls `script` gives for it. */
function fakeLive(script: (n: number, heard: string) => { calls?: { name: string; args: Record<string, unknown> }[]; say?: string; heard?: string; silent?: boolean }) {
  const sent: unknown[] = [];
  let turns = 0;
  class FakeWS {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    private plan: ReturnType<typeof script> | null = null;
    constructor(public url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 5);
    }
    private emit(m: unknown) {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 5);
    }
    send(raw: string) {
      const m = JSON.parse(raw);
      sent.push(m);
      if (m.setup) return this.emit({ setupComplete: {} });
      if (m.realtimeInput?.activityEnd) {
        this.plan = script(turns++, "");
        if (this.plan.heard) this.emit({ serverContent: { inputTranscription: { text: this.plan.heard } } });
        if (this.plan.silent) return;
        if (this.plan.calls?.length) this.emit({ toolCall: { functionCalls: this.plan.calls.map((c, i) => ({ id: `c${i}`, ...c })) } });
        else this.finishTurn();
      }
      if (m.toolResponse) this.finishTurn();
    }
    private finishTurn() {
      if (this.plan?.say) this.emit({ serverContent: { modelTurn: { parts: [{ text: this.plan.say }] } } });
      this.emit({ serverContent: { turnComplete: true } });
    }
    close() {
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code: 1000, reason: "bye" }), 1);
    }
  }
  return { WS: FakeWS as unknown as typeof WebSocket, sent };
}

const speech = new Float32Array(16_000).map((_, i) => 0.2 * Math.sin(i / 5));

describe("the floating agent", () => {
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem("journal.swarm", "off");
    saveAiSettings({ ...DEFAULT_SETTINGS });
    await setKey("gemini", "test-key");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("knows which day '2 days' note' is", () => {
    const wed = new Date(2026, 10, 25, 18, 30);
    const lines = dayLines(wed).join("\n");
    expect(lines).toContain('"2 days\' note": Friday 2026-11-27');
    expect(lines).toContain("tomorrow: Thursday 2026-11-26");
    expect(lines).toContain("Friday (the coming one): 2026-11-27; Friday of next week: 2026-12-04");
    expect(lines).toContain("Monday (the coming one): 2026-11-30; Monday of next week: 2026-11-30");
    expect(lines).toContain("last Monday: 2026-11-23");
    expect(shortDay("2026-11-27", "2026-11-25")).toBe("Fri 27 Nov");
    expect(shortDay("2026-11-26", "2026-11-25")).toBe("tomorrow");
  });

  it("splits rows that came as one comma line (the broken 25 Nov table)", () => {
    const headers = ["Concept", "Nature", "Focus"];
    const rows = normalizeRows(headers, [["Dogs,Living biological species (canines),Companionship, loyalty, and instinct", "Today's Note,Temporal record/document,Reflection"]]);
    expect(rows).toEqual([
      ["Dogs", "Living biological species (canines)", "Companionship, loyalty, and instinct"],
      ["Today's Note", "Temporal record/document", "Reflection"],
    ]);
    expect(normalizeRows(["A", "B"], ["x | y", "p, q"])).toEqual([["x", "y"], ["p", "q"]]);
    expect(normalizeRows(["Trait", "Cow"], [{ Trait: "Legs", Cow: "4" }])).toEqual([["Legs", "4"]]);
    const b = blockFor({ action: "make", kind: "table", headers: ["Trait, Cow, Dog"], rows: [["Legs, 4, 4"]] })!;
    expect(b.headers).toEqual(["Trait", "Cow", "Dog"]);
    expect(b.rows).toEqual([["Legs", "4", "4"]]);
  });

  it("checklists and plain text", () => {
    expect(blockFor({ action: "make", kind: "checklist", lines: ["- [ ] milk", "eggs"] })?.node.content?.length).toBe(2);
    expect(blockFor({ action: "make", kind: "text", lines: ["Finished the gym", "at 7"] })?.node.type).toBe("paragraph");
  });

  it("upper-cases schema types for the Live API", () => {
    expect(liveSchema({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } })).toEqual({ type: "OBJECT", properties: { a: { type: "ARRAY", items: { type: "STRING" } } } });
  });

  it("makes a table in the day it was told, changes it, removes it (Gemini Live)", async () => {
    const store = new MemoryStore();
    const today = dayKey(new Date());
    const inTwo = addDays(today, 2);
    const { WS, sent } = fakeLive((n) =>
      n === 0
        ? { heard: "Make a table comparing cows and dogs in two days' note", calls: [{ name: "make_block", args: { kind: "table", date: inTwo, headers: ["Trait", "Cow", "Dog"], rows: [["Legs", "4", "4"], ["Sound", "Moo", "Woof"]] } }], say: "Made the table on Friday." }
        : n === 1
          ? { heard: "Add a row for lifespan", calls: [{ name: "change_block", args: { kind: "table", headers: ["Trait", "Cow", "Dog"], rows: [["Legs", "4", "4"], ["Sound", "Moo", "Woof"], ["Lifespan", "20 years", "13 years"]] } }] }
          : { heard: "Delete that table", calls: [{ name: "remove_block", args: {} }] },
    );
    const stages: string[] = [];
    const agent = new FloatingAgent({ store, actor: "Assistant", name: "Agent 1", WebSocketImpl: WS, speak: false, onScreen: () => today, events: { onStage: (s) => stages.push(s) } });
    agent.begin();
    agent.audio(speech);
    let r = await agent.finish(speech);
    expect(r.engine).toBe("live");
    expect(r.heard).toMatch(/cows and dogs/);
    expect(r.say).toBe("Made the table on Friday.");
    const day = await store.getDay(inTwo);
    expect(day?.content?.content?.filter((b) => b.type === "sheetBlock")).toHaveLength(1);
    expect(await store.getDay(today)).toBeNull();
    expect(stages.some((s) => s.startsWith("📋 Making a table in"))).toBe(true);
    // The sound was sent between the start and end of the turn, after a fresh note of context.
    const kinds = sent.map((m) => Object.keys(m as object)[0] + ((m as { realtimeInput?: object }).realtimeInput ? `:${Object.keys((m as { realtimeInput: object }).realtimeInput)[0]}` : ""));
    expect(kinds.slice(0, 5)).toEqual(["setup", "clientContent", "realtimeInput:activityStart", "realtimeInput:audio", "realtimeInput:activityEnd"]);

    agent.begin();
    r = await agent.finish(speech);
    const sheets = (await store.getDay(inTwo))?.content?.content?.filter((b) => b.type === "sheetBlock") ?? [];
    expect(sheets).toHaveLength(1);
    expect(String(sheets[0].attrs?.data)).toContain("Lifespan");
    // No answer from the model: said from what the tool did.
    expect(r.say).toMatch(/Changed the table/);

    agent.begin();
    r = await agent.finish(speech);
    expect((await store.getDay(inTwo))?.content?.content?.some((b) => b.type === "sheetBlock")).toBe(false);
    agent.close();
  });

  it("goes the written-down way when Live goes quiet", async () => {
    const store = new MemoryStore();
    const today = dayKey(new Date());
    const { WS } = fakeLive(() => ({ heard: "write that I finished the gym at 7", silent: true }));
    // Gemini text: one tool call, then the answer.
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call++;
      const parts = call === 1 ? [{ functionCall: { name: "make_block", args: { kind: "text", lines: ["Finished the gym at 7"] } } }] : [{ text: "Written in today." }];
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] }), { status: 200 });
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const agent = new FloatingAgent({ store, actor: "Assistant", name: "Agent 1", WebSocketImpl: WS, speak: false, onScreen: () => today });
    agent.begin();
    const done = agent.finish(speech);
    await vi.advanceTimersByTimeAsync(12_000);
    const r = await done;
    vi.useRealTimers();
    expect(r.engine).toBe("text");
    expect(r.say).toBe("Written in today.");
    expect(docText((await store.getDay(today))!.content!)).toContain("Finished the gym at 7");
    agent.close();
  });

  it("says what it's doing", () => {
    const now = new Date(2026, 10, 25);
    expect(stageFor("make_block", { kind: "table", date: "2026-11-27" }, now)).toBe("📋 Making a table in Fri 27 Nov…");
    expect(stageFor("add_reminder", { date: "2026-11-26" }, now)).toBe("⏰ Reminder for tomorrow…");
    expect(summaryOf([{ name: "make_block", args: {}, out: "Made a table in 2026-11-27:\n| a |", bad: false }], now)).toBe("📋 Table → Fri 27 Nov");
  });

  it("deletes small things without asking (Settings › Agent)", async () => {
    const store = new MemoryStore();
    const day = "2026-11-25";
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    await store.saveDay({
      day,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "buy milk" }] }, { type: "paragraph", content: [{ type: "text", text: long }] }, { type: "paragraph", content: [{ type: "text", text: "another " + long }] }] },
      plainText: "",
      actor: "me",
    });
    const ctx = { store, actor: "Assistant", now: new Date(2026, 10, 25) };
    expect(await smallDelete({ name: "delete_lines", arguments: { lines: ["buy milk"], date: day } }, ctx)).toBe(true);
    // One long block: allowed while "any single block" is on.
    expect(await smallDelete({ name: "delete_block", arguments: { n: 2, date: day } }, ctx)).toBe(true);
    // Two long paragraphs: asks.
    expect(await smallDelete({ name: "delete_lines", arguments: { lines: ["word0", "another"], date: day } }, ctx)).toBe(false);
    saveAiSettings({ ...DEFAULT_SETTINGS, agentDeleteBlock: false });
    expect(await smallDelete({ name: "delete_block", arguments: { n: 2, date: day } }, ctx)).toBe(false);
    saveAiSettings({ ...DEFAULT_SETTINGS, agentFreeDelete: false });
    expect(await smallDelete({ name: "delete_lines", arguments: { lines: ["buy milk"], date: day } }, ctx)).toBe(false);
  });
});

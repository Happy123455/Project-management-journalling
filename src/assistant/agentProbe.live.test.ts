// @vitest-environment node
// The floating agent against the real Gemini (run on the Mac with the key; skipped everywhere else):
//   GEMINI_KEY=… PROBE_AUDIO_DIR=…/audio PROBE_OUT=…/probe.json npx vitest run src/assistant/agentProbe.live.test.ts
// Spoken test sentences (16 kHz mono WAVs made with `say`) stream to Gemini Live in real time,
// like a person talking; the journal is a MemoryStore. Prints and saves what was heard, what it
// did, where, and how long each took after "done talking".
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.GEMINI_KEY;
const AUDIO = process.env.PROBE_AUDIO_DIR;
const OUT = process.env.PROBE_OUT;
const VOICES = (process.env.PROBE_VOICES ?? "default,rishi,isha").split(",");

function shim() {
  const g = globalThis as Record<string, unknown>;
  const et = new EventTarget();
  const kept = new Map<string, string>();
  g.window = globalThis;
  g.addEventListener = et.addEventListener.bind(et);
  g.removeEventListener = et.removeEventListener.bind(et);
  g.dispatchEvent = et.dispatchEvent.bind(et);
  g.localStorage = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, String(v)),
    removeItem: (k: string) => void kept.delete(k),
    clear: () => kept.clear(),
    key: (i: number) => [...kept.keys()][i] ?? null,
    get length() {
      return kept.size;
    },
  };
  // No swarm shows (no screen here).
  g.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  if (process.env.PROBE_LIVE_MODEL) kept.set("journal.agentLiveModel", process.env.PROBE_LIVE_MODEL);
  if (process.env.PROBE_TEXT) kept.set("journal.agentLiveText", process.env.PROBE_TEXT);
}

/** A 16-bit mono WAV's samples. */
function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  let at = 12;
  while (at < b.length - 8) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "data") {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(at + 8 + i * 2) / 0x8000;
      return out;
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${path}`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!KEY || !AUDIO)("floating agent with the real Gemini", () => {
  it("does the spoken requests, in the right notes, quickly", async () => {
    shim();
    const { setKey } = await import("../ai/secrets");
    const { MemoryStore } = await import("../store/memoryStore");
    const { FloatingAgent, writeDown } = await import("./liveAgent");
    const { dayKey, addDays } = await import("../lib/timestamp");
    const { docText } = await import("../lib/words");
    await setKey("gemini", KEY!);
    const today = dayKey(new Date());
    (globalThis as { __journalOpenDay?: () => string }).__journalOpenDay = () => today;
    const files = readdirSync(AUDIO!).filter((f) => f.endsWith(".wav"));
    const report: Record<string, unknown>[] = [];
    const log = (o: Record<string, unknown>) => {
      report.push(o);
      console.log(JSON.stringify(o));
    };

    for (const voice of VOICES) {
      const store = new MemoryStore();
      const stages: string[] = [];
      const agent = new FloatingAgent({
        store,
        actor: "Assistant",
        name: "Agent 1",
        WebSocketImpl: globalThis.WebSocket,
        speak: false,
        events: { onStage: (s) => stages.push(s), confirm: async () => true },
      });
      const w0 = Date.now();
      const s = await agent.warm();
      log({ voice, step: "open", ok: !!s, ms: Date.now() - w0, trouble: agent.liveTrouble, text: localStorage.getItem("journal.agentLiveText") });
      for (const a of ["a1", "a2", "a3", "a4", "a5"]) {
        const f = files.find((x) => x.startsWith(`${a}-${voice}`));
        if (!f) continue;
        const samples = readWav(join(AUDIO!, f));
        stages.length = 0;
        agent.begin();
        // Real time: 100 ms pieces, as the microphone hands them over.
        for (let i = 0; i < samples.length; i += 1600) {
          agent.audio(samples.slice(i, i + 1600));
          await wait(100);
        }
        const t0 = Date.now();
        const r = await agent.finish(samples);
        const ms = Date.now() - t0;
        const days: Record<string, string> = {};
        for (const d of await store.listDays()) {
          const p = await store.getDay(d);
          const sheets = (p?.content?.content ?? []).filter((n) => n.type === "sheetBlock").map((n) => {
            const data = JSON.parse(String(n.attrs?.data ?? "{}"));
            return JSON.stringify(data.cells ?? data).slice(0, 400);
          });
          days[d] = `${docText(p?.content ?? { type: "doc" }).slice(0, 300)}${sheets.length ? ` [sheets: ${sheets.join(" / ")}]` : ""}`;
        }
        log({ voice, step: a, ms, engine: r.engine, heard: r.heard, say: r.say, ok: r.ok, did: r.did, stages: [...stages], days });
      }
      agent.close();
      if (voice === VOICES[0]) {
        // The written-down way for the first sentence, for comparison.
        const f = files.find((x) => x.startsWith(`a1-${voice}`));
        if (f) {
          const samples = readWav(join(AUDIO!, f));
          const t0 = Date.now();
          const words = await writeDown(samples);
          log({ voice, step: "writeDown a1", ms: Date.now() - t0, words });
          const store2 = new MemoryStore();
          const textAgent = new FloatingAgent({ store: store2, actor: "Assistant", name: "Agent 1", engine: "text", events: { confirm: async () => true } });
          const t1 = Date.now();
          const r = await textAgent.text(words || "Make a table comparing cows and dogs in two days' note");
          const d2 = await store2.getDay(addDays(today, 2));
          log({ voice, step: "text path a1", ms: Date.now() - t1, say: r.say, did: r.did, inTwoDays: !!d2?.content?.content?.some((n) => n.type === "sheetBlock") });
        }
      }
    }
    if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
    const first = report.find((r) => r.step === "a1") as { days?: Record<string, string> } | undefined;
    expect(first?.days?.[addDays(today, 2)] ?? "").toMatch(/cow/i);
  }, 600_000);
});

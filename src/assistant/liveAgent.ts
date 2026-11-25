// One floating agent's ears and hands (25 Nov, Hapi: "the AI isn't listening… make a table between
// cows and dogs in 2 days' note… it still didn't do it… it's taking too long").
//
// Before: the phone's small Whisper wrote the words down (it dropped "cows" and heard "2 days'"
// as "today's"), a small model planned a block for the note on screen only, and anything else
// started a second, full assistant run: about 1.5 minutes, and the wrong note.
//
// Now Gemini Live hears the voice itself while Hapi talks (nothing to write down first) and calls
// the journal's tools straight away: make a block in any day's note, change it, reminders, money,
// opening notes… One session per bubble, opened when it appears, so follow-ups ("add a row for
// lifespan") keep their context. If Live can't be reached, the recording is written down (Gemini,
// then Whisper) and the same tools run with Gemini's text model: one path, never a silent wait.
import type { JournalStore } from "../store";
import { getKey } from "../ai/secrets";
import { declarations, geminiAgent } from "../ai/geminiTools";
import { loadAiSettings, recordUsage } from "../ai/settings";
import { transcribe, pickEngine } from "../ai/voice";
import { openLiveWith, type LiveCall, type LiveSession } from "../talk/geminiLive";
import { cursorFx } from "./AgentCursors";
import { agentSystem, agentToolList, whereSaid, type AgentMemory } from "./agentTools";
import { liveDay, liveTurn, type LiveCtx } from "./live";
import { runAssistantTool, type RunCtx } from "./tools";

/** Live models, best first (Hapi's key lists both, 25 Nov). Override: localStorage journal.agentLiveModel. */
export const AGENT_LIVE_MODELS = ["gemini-3.8-live", "gemini-3.1-flash-live-preview"];
/** The text fallback: quickest first. */
export const AGENT_TEXT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-flash-lite-latest"];

export interface AgentTurn {
  /** What it heard. */
  heard: string;
  /** The short answer to show by the bubble. */
  say: string;
  ok: boolean;
  /** The tools it used ("✓ make_block 2026-11-27"). */
  did: string[];
  engine: "live" | "text" | "local";
  /** From "done talking" to the answer. */
  ms: number;
}

export interface AgentEvents {
  /** Words as Gemini hears them (grows during the turn). */
  onHeard?: (text: string) => void;
  /** What it's doing now: "Thinking…", "📋 Making a table in Fri 27 Nov…". */
  onStage?: (text: string) => void;
  /** Its answer so far. */
  onSaid?: (text: string) => void;
  /** Asks Hapi (a deletion bigger than the Settings allow, a second note). */
  confirm?: (q: string) => Promise<boolean>;
}

export interface AgentOptions {
  store: JournalStore;
  actor: string;
  /** "Agent 1". */
  name: string;
  events?: AgentEvents;
  /** Tests and the probe. */
  WebSocketImpl?: typeof WebSocket;
  now?: () => Date;
  /** The note on screen (YYYY-MM-DD or a page title). */
  onScreen?: () => string | null;
  /** Force an engine (tests, Settings). */
  engine?: "live" | "text";
  /** Speak the answer (Settings › Agent). */
  speak?: boolean;
}

const IDLE_CLOSE_MS = 4 * 60_000;
/** After "done talking": no sign of an answer in this long → the written-down way. */
const FIRST_ANSWER_MS = 9_000;
/** A whole turn, tools included (opening a far note plays a short show). */
const TURN_MS = 75_000;

function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Not kept.
  }
}

/** A request that should have used a tool (it only talked): asked again once. */
const ASKS_FOR_WORK = /\b(make|add|create|write|put|note|remind|reminder|delete|remove|open|show|table|list|compare|comparison|change|move|plan|log|save|set|tick|mark)\b/i;

/** What the bubble says while a tool runs. */
export function stageFor(name: string, a: Record<string, unknown>, now = new Date(), onScreen: string | null = null): string {
  const where = () => {
    const w = typeof a.title === "string" && a.title ? a.title : typeof a.date === "string" && a.date ? a.date : onScreen || liveDay();
    return whereSaid(w, now);
  };
  const kind = typeof a.kind === "string" ? a.kind : "block";
  switch (name) {
    case "make_block":
      return `${kind === "table" ? "📋" : kind === "checklist" ? "☑️" : "✍️"} Making a ${kind} in ${where()}…`;
    case "change_block":
      return "✏️ Changing it…";
    case "remove_block":
    case "delete_block":
    case "delete_lines":
      return "🗑 Removing it…";
    case "add_reminder":
      return `⏰ Reminder for ${where()}…`;
    case "add_deadline":
      return "⏳ Adding the deadline…";
    case "open":
      return `📖 Opening ${typeof a.target === "string" ? whereSaid(a.target, now) : "it"}…`;
    case "append":
    case "put_under":
    case "replace_text":
    case "replace_block":
    case "insert_after":
      return `✍️ Writing in ${where()}…`;
    case "pocket":
      return "👛 Pocket…";
    case "search":
    case "day_list":
    case "find_tasks":
    case "find_media":
      return "🔍 Looking…";
    default:
      return /^read|today|list_/.test(name) ? "👀 Reading…" : "⚙️ Working…";
  }
}

/** The answer when the model says nothing: from what the tools did. */
export function summaryOf(calls: { name: string; args: Record<string, unknown>; out: string; bad: boolean }[], now = new Date()): string {
  const good = calls.filter((c) => !c.bad);
  const last = good[good.length - 1];
  if (!last) return calls.length ? `Couldn't: ${calls[calls.length - 1].out.split("\n")[0].slice(0, 120)}` : "";
  const made = last.out.match(/^Made an? (\w+) in ([^:\s]+)/);
  if (made) return `${made[1] === "table" ? "📋 Table" : made[1] === "checklist" ? "☑️ Checklist" : made[1] === "list" ? "📝 List" : "✍️ Written"} → ${whereSaid(made[2], now)}`;
  return last.out.split("\n")[0].slice(0, 140);
}

type Call = { name: string; args: Record<string, unknown>; out: string; bad: boolean };
type Pending = { chunks: Float32Array[]; began: boolean; ended: boolean; cancelled?: boolean; heard: string; said: string; calls: Call[]; activity: number; done?: (ok: boolean) => void; ctx?: RunCtx };

export class FloatingAgent {
  readonly mem: AgentMemory = { last: null };
  private live: LiveSession | null = null;
  private opening: Promise<LiveSession | null> | null = null;
  private idle = 0;
  /** The recording in progress. */
  private rec: Pending | null = null;
  /** The request Live is answering now. */
  private active: Pending | null = null;
  /** Requests run one after another (a new recording while the last one still runs waits). */
  private chain: Promise<unknown> = Promise.resolve();
  private history: { role: "user" | "assistant"; content: string }[] = [];
  private closed = false;
  /** Why Live couldn't be used. */
  liveTrouble = "";

  constructor(private o: AgentOptions) {}

  private now = () => this.o.now?.() ?? new Date();
  private onScreen = () => this.o.onScreen?.() ?? (typeof window !== "undefined" ? window.__journalOpenDay?.() ?? null : null);
  private engine = () => this.o.engine ?? (loadAiSettings().agentEngine === "whisper" ? "text" : "live");
  private speak = () => this.o.speak ?? loadAiSettings().agentSpeak === true;

  /** Opens the Live line now (the bubble appeared, or a recording starts). Null when it can't. */
  warm(): Promise<LiveSession | null> {
    if (this.closed || this.engine() !== "live") return Promise.resolve(null);
    if (this.live?.open()) return Promise.resolve(this.live);
    this.opening ??= this.connect().finally(() => (this.opening = null));
    return this.opening;
  }

  private async connect(): Promise<LiveSession | null> {
    if (!(await getKey("gemini"))) {
      this.liveTrouble = "no Gemini key";
      return null;
    }
    const tools = declarations(await agentToolList());
    const speak = this.speak();
    const forced = storageGet("journal.agentLiveModel");
    const models = forced ? [forced] : AGENT_LIVE_MODELS;
    // Written answers when it doesn't speak (quicker), if the model takes them; else spoken, muted.
    const textOk = storageGet("journal.agentLiveText");
    const modalities: ("TEXT" | "AUDIO")[] = speak ? ["AUDIO"] : textOk === "0" ? ["AUDIO"] : ["TEXT", "AUDIO"];
    for (const model of models)
      for (const modality of modalities) {
        if (this.closed) return null;
        try {
          const s: LiveSession = await openLiveWith(
            agentSystem({ name: this.o.name, now: this.now(), onScreen: this.onScreen(), last: this.mem.last, speak }),
            {
              onHeard: (t) => {
                if (this.active) this.active.heard = t;
                this.o.events?.onHeard?.(t);
              },
              onSaid: (t) => {
                if (this.active) this.active.said = t;
                this.o.events?.onSaid?.(t);
              },
              onActivity: () => {
                if (this.active) this.active.activity = Date.now();
              },
              onTurn: (me, ai) => {
                const t = this.active;
                if (!t) return;
                if (me) t.heard = me;
                if (ai) t.said = ai;
                t.done?.(true);
              },
              onClose: (why) => {
                if (this.live === s) this.live = null;
                this.active?.done?.(false);
                console.info("[agent] Live closed:", why);
              },
            },
            {
              model,
              modality,
              tools,
              play: speak,
              voice: "Puck",
              setupMs: 7000,
              WebSocketImpl: this.o.WebSocketImpl,
              onToolCall: (calls) => this.runCalls(calls),
              onUsage: (m, i, out) => recordUsage(m, i, out),
            },
          );
          if (modality === "TEXT") storageSet("journal.agentLiveText", "1");
          this.live = s;
          this.liveTrouble = "";
          this.touch();
          return s;
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          console.info(`[agent] Live ${model} ${modality} didn't open: ${why}`);
          // The model doesn't do written answers: spoken (muted) from now on.
          if (modality === "TEXT" && /modalit|TEXT|response/i.test(why)) storageSet("journal.agentLiveText", "0");
          this.liveTrouble = why;
          if (/key/i.test(why)) return null;
        }
      }
    return null;
  }

  /** Closes the line after a few quiet minutes (it opens again on the next tap). */
  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (!this.active && !this.rec) {
        this.live?.close();
        this.live = null;
      }
    }, IDLE_CLOSE_MS) as unknown as number;
  }

  /** Starts `t` on the line: what time it is and what's on screen, then the sound so far. */
  private beginOn(s: LiveSession, t: Pending) {
    if (t.began || t.cancelled) return;
    t.began = true;
    this.active = t;
    const screen = this.onScreen();
    s.note(`(Now ${this.now().toTimeString().slice(0, 5)}. On screen: ${screen ? (/^\d{4}-\d{2}-\d{2}$/.test(screen) ? `the day note ${screen}` : `the page "${screen}"`) : "today's note"}. The block you made last: ${this.mem.last ? `a ${this.mem.last.kind} in ${this.mem.last.title ?? this.mem.last.day}` : "none yet"}.)`);
    s.begin();
    for (const c of t.chunks) s.audio(c);
    t.chunks = [];
  }

  /** A recording starts. Its sound goes to Live as it comes (kept until the line is open). */
  begin() {
    if (this.rec && !this.rec.ended) return;
    const t: Pending = { chunks: [], began: false, ended: false, heard: "", said: "", calls: [], activity: 0 };
    this.rec = t;
    this.o.events?.onHeard?.("");
    // After the request before it is answered.
    void this.chain.then(async () => {
      const s = await this.warm();
      if (s?.open() && !t.cancelled) this.beginOn(s, t);
    });
  }

  /** 16 kHz samples of the voice, as they come. */
  audio(chunk: Float32Array) {
    const t = this.rec;
    if (!t || t.ended || t.cancelled) return;
    if (t.began && this.active === t && this.live?.open()) this.live.audio(chunk);
    else if (t.chunks.length < 4000) t.chunks.push(chunk);
  }

  /** Dropped (held, or the bubble closed): nothing is done. */
  cancel() {
    const t = this.rec;
    this.rec = null;
    if (!t) return;
    t.cancelled = true;
    if (this.active === t) {
      // Half a request on the line: start the line afresh rather than have it answer half a sentence.
      this.active = null;
      this.live?.close();
      this.live = null;
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.idle);
    this.rec = null;
    this.active = null;
    this.live?.close();
    this.live = null;
  }

  /** Done talking. `samples`: the whole recording (for the written-down way). */
  finish(samples: Float32Array): Promise<AgentTurn> {
    const t = this.rec;
    if (!t) return Promise.resolve({ heard: "", say: "", ok: true, did: [], engine: "live", ms: 0 });
    t.ended = true;
    this.rec = null;
    const run = this.chain.then(() => this.finishTurn(t, samples));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async finishTurn(t: Pending, samples: Float32Array): Promise<AgentTurn> {
    const t0 = Date.now();
    this.o.events?.onStage?.("Thinking…");
    try {
      if (this.engine() === "live" && !t.cancelled) {
        const s = t.began && this.live?.open() ? this.live : await Promise.race([this.warm(), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
        if (s?.open()) {
          this.beginOn(s, t);
          if (this.active === t) {
            const r = await this.awaitLive(t, s);
            if (r) return { ...r, ms: Date.now() - t0 };
          }
        }
      }
      // The written-down way: what Live heard if it heard anything, else the recording itself.
      let text = t.heard.trim();
      if (!text) {
        this.o.events?.onStage?.("✍️ Writing it down…");
        text = await writeDown(samples);
      }
      if (!text) return { heard: "", say: "Didn't catch any words. Tap to try again.", ok: false, did: [], engine: "text", ms: Date.now() - t0 };
      this.o.events?.onHeard?.(text);
      const r = await this.text(text);
      return { ...r, ms: Date.now() - t0 };
    } finally {
      if (this.active === t) this.active = null;
      this.touch();
    }
  }

  /** Waits for Live's answer; null when it went quiet or the line dropped before doing anything. */
  private awaitLive(t: Pending, s: LiveSession): Promise<Omit<AgentTurn, "ms"> | null> {
    return new Promise((resolve) => {
      let sent = Date.now();
      let nudged = false;
      let watch = 0;
      const finish = (r: Omit<AgentTurn, "ms"> | null) => {
        clearInterval(watch);
        t.done = undefined;
        resolve(r);
      };
      const end = (ok: boolean) => {
        // Nothing done and the line went: the written-down way takes over.
        if (!ok && !t.calls.length) return finish(null);
        const said = t.said.trim();
        // It only talked about doing it: asked once more, plainly.
        if (ok && !t.calls.length && !nudged && ASKS_FOR_WORK.test(t.heard) && !/didn'?t catch/i.test(said)) {
          nudged = true;
          t.said = "";
          sent = t.activity = Date.now();
          s.text("(You didn't use a tool. Do what I asked now, with the tools.)");
          return;
        }
        const did = t.calls.map((c) => `${c.bad ? "⚠" : "✓"} ${c.name}${typeof c.args.date === "string" ? ` ${c.args.date}` : ""}${typeof c.args.title === "string" ? ` “${c.args.title}”` : ""}`);
        const okAll = !t.calls.length || t.calls.some((c) => !c.bad);
        const heard = t.heard.trim();
        if (heard) this.history.push({ role: "user", content: heard });
        if (said) this.history.push({ role: "assistant", content: said });
        this.history = this.history.slice(-8);
        finish({ heard, say: said || summaryOf(t.calls, this.now()) || (heard ? "Done." : "Didn't catch that."), ok: okAll, did, engine: "live" });
      };
      t.done = end;
      t.activity = 0;
      watch = setInterval(() => {
        if (!s.open()) return end(false);
        // No sign of an answer after "done talking" (and no tool running).
        if (!t.calls.length && t.activity < sent && Date.now() - sent > FIRST_ANSWER_MS) return end(false);
        if (Date.now() - sent > TURN_MS) return end(t.calls.length > 0);
      }, 400) as unknown as number;
      s.done();
    });
  }

  private runCtx(): RunCtx {
    return { store: this.o.store, actor: this.o.actor, now: this.now(), confirm: this.o.events?.confirm, touched: new Set(), found: [], opened: [], live: this.mem };
  }

  /** Runs Live's function calls with the journal's tools (one run context per request). */
  private async runCalls(calls: LiveCall[]): Promise<Record<string, unknown>[]> {
    const t = this.active;
    const ctx = t ? (t.ctx ??= this.runCtx()) : this.runCtx();
    const out: Record<string, unknown>[] = [];
    for (const c of calls) {
      const r = await this.tool(c.name, c.args, ctx);
      if (t) {
        t.calls.push({ name: c.name, args: c.args, out: r.out, bad: r.bad });
        t.activity = Date.now();
      }
      out.push(r.bad ? { error: r.out.slice(0, 4000) } : { result: r.out.slice(0, 4000) });
    }
    return out;
  }

  private async tool(name: string, args: Record<string, unknown>, ctx: RunCtx) {
    this.o.events?.onStage?.(stageFor(name, args, this.now(), this.onScreen()));
    try {
      return await runAssistantTool({ name, arguments: args }, ctx);
    } catch (e) {
      return { out: e instanceof Error ? e.message : String(e), bad: true };
    }
  }

  /** A request in words (typed, or written down from the recording): Gemini's text model with the same tools. */
  async text(said: string): Promise<Omit<AgentTurn, "ms">> {
    const heard = said.trim();
    if (!(await getKey("gemini"))) {
      // No Gemini at all: the old quick way (the Mac's local model).
      const lctx: LiveCtx = { store: this.o.store, actor: this.o.actor, last: this.mem.last, said: this.history.filter((h) => h.role === "user").map((h) => h.content) };
      const r = await liveTurn(heard, lctx, undefined, this.o.events?.confirm);
      this.mem.last = lctx.last;
      return { heard, say: r.say, ok: r.ok, did: [], engine: "local" };
    }
    const ctx = this.runCtx();
    const calls: Call[] = [];
    this.o.events?.onStage?.("Thinking…");
    const r = await geminiAgent({
      store: this.o.store,
      system: agentSystem({ name: this.o.name, now: this.now(), onScreen: this.onScreen(), last: this.mem.last }),
      messages: [...this.history.slice(-6), { role: "user", content: heard }],
      actor: this.o.actor,
      tools: await agentToolList(),
      chain: AGENT_TEXT_MODELS,
      model: AGENT_TEXT_MODELS[0],
      think: "minimal",
      maxRounds: 6,
      fastTimeoutMs: 15_000,
      retryForMs: 20_000,
      runTool: async (call) => {
        const out = await this.tool(call.name, call.arguments, ctx);
        calls.push({ name: call.name, args: call.arguments, out: out.out, bad: out.bad });
        return out;
      },
    });
    const say = r.text.split("\n")[0].slice(0, 160) || summaryOf(calls, this.now());
    this.history.push({ role: "user", content: heard }, { role: "assistant", content: say });
    this.history = this.history.slice(-8);
    const did = calls.map((c) => `${c.bad ? "⚠" : "✓"} ${c.name}${typeof c.args.date === "string" ? ` ${c.args.date}` : ""}`);
    return { heard, say, ok: !calls.length || calls.some((c) => !c.bad), did, engine: "text" };
  }
}

/** The recording in words: Gemini first (it heard Hapi best), Whisper when Gemini can't be reached. */
export async function writeDown(samples: Float32Array): Promise<string> {
  if (samples.length < 16_000 * 0.3) return "";
  try {
    const t = await transcribe("gemini", samples);
    if (t) return t;
  } catch (e) {
    console.info("[agent] Gemini couldn't write it down:", e);
  }
  try {
    if ((await pickEngine()) === "whisper") return await transcribe("whisper", samples, "", undefined, "en");
  } catch (e) {
    console.info("[agent] Whisper couldn't write it down:", e);
  }
  return "";
}

/** The arrows that orbit a busy bubble (AgentCursors) for a run of the agent. */
export function busyArrows(actor: string, key: string, on: boolean) {
  cursorFx(on ? { key: actor, phase: "think", anchor: `.agent-bubble[data-agent-key="${key}"]` } : { key: actor, phase: "done" });
}

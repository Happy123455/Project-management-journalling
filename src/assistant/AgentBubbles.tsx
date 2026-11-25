// Floating AI agents. Hold Home, draw it up into the top third of the screen and let go: a bubble
// floats there, an assistant of its own (the same one as ✦: chat, type or talk, long step lists,
// schedules). Do it again for another, each working on its own job at the same time. Tap a bubble
// to open or fold its chat; drag it back onto Home and it merges in and closes.
// Light on the battery: no timers or frames of its own; only CSS moves while a bubble is busy.
//
// Live (Hapi, 21 Nov: "like Gemini Live, no big chat"): no big chat; what you say is done by the
// fastest model (live.ts) and its block is changed in place when corrected. Holding a bubble
// opens the old chat.
// 22 Nov, Hapi: no end-of-speech guessing ("even when I done talking it's still listening so it
// doesn't execute"). Tap = start recording, tap again = that's my answer. Tap again to talk again.
// 25 Nov, Hapi: "the AI isn't listening… it didn't do it… it's taking too long". Each bubble now
// has a Gemini Live line (liveAgent.ts), opened as it appears: the voice streams while Hapi talks,
// Gemini hears it itself and calls the journal's tools, and the bubble says what it heard, what
// it's doing and what it did, with ↩ to put it back.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { haptic } from "../lib/haptic";
import { ASSISTANT_ACTOR } from "./runner";
import { AGENT_ANSWER, CommandBar, type AgentStatus } from "./CommandBar";
import { dismissBubble } from "./swarm/gone";
import { swarmOff } from "./swarm/run";
import { BUBBLE_MOVED, cursorFx } from "./AgentCursors";
import { VoicePill } from "../talk/VoicePill";
import { recordPcm, type PcmRecording } from "../ai/voice";
import { FloatingAgent, undoSince } from "./liveAgent";
import { showToast } from "../lib/toast";

export const AGENT_SPAWN = "journal:agent-spawn";
export const spawnAgent = (x: number, y: number) => window.dispatchEvent(new CustomEvent(AGENT_SPAWN, { detail: { x, y } }));

const SIZE = 54;
const MERGE_R = 64;
const MAX_AGENTS = 6;

interface Agent {
  id: string;
  n: number;
  x: number;
  y: number;
  status: AgentStatus;
  last: string;
  /** Finished (or asking) while folded away: a dot until it's opened. */
  unseen: boolean;
  merging?: { x: number; y: number };
  /** Its closing show is playing (the real bubble is hidden under it). */
  gone?: boolean;
  /** Listening (live). */
  live?: boolean;
  /** Words being heard, and the short answer shown by the bubble. */
  heard?: string;
  /** Live: what the ear is doing right now (hearing you, writing it down). */
  ear?: string;
  say?: string;
  /** What it's doing now ("📋 Making a table in Fri 27 Nov…"). */
  stage?: string;
  /** Its last request: ↩ puts back what it changed since this time (ISO). */
  undo?: string;
  /** Seconds the request has taken so far (shown after 2 s). */
  secs?: number;
}

const HOLD_MS = 450;

const clampPos = (x: number, y: number) => ({
  x: Math.max(SIZE / 2 + 6, Math.min(window.innerWidth - SIZE / 2 - 6, x)),
  y: Math.max(SIZE / 2 + 34, Math.min(window.innerHeight - SIZE / 2 - 90, y)),
});

/** Home's middle, where a bubble dropped near it merges in (none on the Mac). */
function homeCenter(): { x: number; y: number } | null {
  const el = document.querySelector<HTMLElement>(".nav-island:not(.away) .nav-home");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/** First free number, so names stay short (Agent 1, Agent 2, …). */
function nextNumber(list: Agent[]): number {
  for (let n = 1; ; n++) if (!list.some((a) => a.n === n)) return n;
}

export function AgentBubbles({ store }: { store: JournalStore }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [nearHome, setNearHome] = useState(false);
  // Touches on a bubble or its chat stay there: the page's swipes (day change, pull to today,
  // calendar pulls) listen on the window and the app, and moving a bubble sideways set them off.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const has = agents.length > 0;
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const kinds = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
    for (const k of kinds) el.addEventListener(k, stop, { passive: true });
    return () => kinds.forEach((k) => el.removeEventListener(k, stop));
  }, [has]);
  const openRef = useRef(open);
  openRef.current = open;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => {
    const on = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      const list = agentsRef.current;
      if (list.length >= MAX_AGENTS) return void haptic("warn", 1);
      const n = nextNumber(list);
      const id = `ag${Date.now().toString(36)}${n}`;
      const agent: Agent = { id, n, ...clampPos(x, y), status: "idle", last: "", unseen: false };
      agentsRef.current = [...list, agent];
      setAgents(agentsRef.current);
      // A new agent is live at once (no chat panel; hold it for that).
      window.setTimeout(() => void goLive(agent), 260);
    };
    window.addEventListener(AGENT_SPAWN, on);
    return () => window.removeEventListener(AGENT_SPAWN, on);
  }, []);

  // Home glows while a bubble is held over it.
  useEffect(() => {
    document.documentElement.classList.toggle("agent-near-home", nearHome);
  }, [nearHome]);

  const patch = useCallback((id: string, p: Partial<Agent>) => setAgents((list) => list.map((a) => (a.id === id ? { ...a, ...p } : a))), []);
  const remove = useCallback((id: string) => {
    brains.current.get(id)?.close();
    brains.current.delete(id);
    setAgents((list) => list.filter((a) => a.id !== id));
    setOpen((o) => (o === id ? null : o));
  }, []);
  const merge = (a: Agent, at: { x: number; y: number }, from: { x: number; y: number }) => {
    haptic("edge", 1);
    if (swarmOff()) {
      // Reduced motion (or the swarm off): the old quick merge.
      patch(a.id, { merging: at });
      document.documentElement.classList.add("agent-merged");
      window.setTimeout(() => document.documentElement.classList.remove("agent-merged"), 520);
      window.setTimeout(() => remove(a.id), 340);
      return;
    }
    // The long goodbye (Hapi, 18 Nov: it went too quickly): the bubble cracks into sparks that
    // spiral into Home (swarm/gone.ts). Its chat folds at once; it's removed when the show ends.
    patch(a.id, { merging: from, gone: true });
    const homeEl = document.querySelector<HTMLElement>(".nav-island:not(.away) .nav-home");
    void dismissBubble(from, at, `Agent ${a.n}`, homeEl).then(() => remove(a.id));
  };

  // ── Live ──
  /** Each bubble's Gemini Live line and hands (liveAgent.ts). */
  const brains = useRef(new Map<string, FloatingAgent>());
  /** The microphone, while a bubble records. */
  const mics = useRef(new Map<string, { pcm: PcmRecording | null; cancelled?: boolean }>());
  /** A live agent's open yes/no (a deletion…): a tap or a spoken "yes" says yes. */
  const asks = useRef(new Map<string, (yes: boolean) => void>());
  const askLive = (id: string, q: string) =>
    new Promise<boolean>((resolve) => {
      haptic("warn", 1);
      const done = (yes: boolean) => {
        asks.current.delete(id);
        window.clearTimeout(t);
        patch(id, { status: "run" });
        say(id, yes ? "OK, doing it" : "Left it", 1500);
        resolve(yes);
      };
      // No answer in a minute: no.
      const t = window.setTimeout(() => done(false), 60_000);
      asks.current.set(id, done);
      patch(id, { status: "ask" });
      say(id, `${q} Tap = yes, hold = no`, 60_000);
    });
  const sayTimer = useRef(new Map<string, number>());
  const say = (id: string, text: string, ms = 5000) => {
    patch(id, { say: text });
    window.clearTimeout(sayTimer.current.get(id));
    if (text) sayTimer.current.set(id, window.setTimeout(() => patch(id, { say: "", undo: undefined }), ms));
  };
  const actorOf = (a: Agent) => (a.n === 1 ? ASSISTANT_ACTOR : `${ASSISTANT_ACTOR} ${a.n}`);
  const brainOf = (a: Agent) => {
    let b = brains.current.get(a.id);
    if (!b)
      brains.current.set(
        a.id,
        (b = new FloatingAgent({
          store,
          actor: actorOf(a),
          name: `Agent ${a.n}`,
          events: {
            onHeard: (t) => patch(a.id, { heard: t }),
            onStage: (t) => patch(a.id, { stage: t }),
            confirm: (q) => askLive(a.id, q),
          },
        })),
      );
    return b;
  };
  const levelEl = (id: string) => document.querySelector<HTMLElement>(`.agent-bubble[data-agent-key="${id}"]`);
  /** Drops a recording without doing anything (hold, merge, closing). */
  const stopLive = (id: string) => {
    const m = mics.current.get(id);
    if (!m) return;
    mics.current.delete(id);
    m.cancelled = true;
    m.pcm?.cancel();
    brains.current.get(id)?.cancel();
    patch(id, { live: false, heard: "", ear: "" });
    levelEl(id)?.style.setProperty("--lvl", "0");
  };
  /** Second tap: that's the request. Gemini already heard it; now it acts. */
  const submit = async (a: Agent) => {
    const m = mics.current.get(a.id);
    if (!m) return;
    mics.current.delete(a.id);
    haptic("press", 0.8);
    levelEl(a.id)?.style.setProperty("--lvl", "0");
    const since = new Date(Date.now() - 1000).toISOString();
    patch(a.id, { live: false, ear: "", status: "run", stage: "Thinking…", say: "", secs: 0, undo: undefined });
    const samples = (await m.pcm?.stop().catch(() => null)) ?? new Float32Array(0);
    const actor = actorOf(a);
    cursorFx({ key: actor, phase: "think", anchor: `.agent-bubble[data-agent-key="${a.id}"]` });
    // Seconds, so a slow answer never looks like nothing is happening.
    const t0 = Date.now();
    const tick = window.setInterval(() => patch(a.id, { secs: Math.round((Date.now() - t0) / 1000) }), 1000);
    try {
      const r = await brainOf(a).finish(samples);
      const changed = r.did.some((d) => d.startsWith("✓") && !/✓ (read|today|search|day_list|find|list_|open|pocket_status|math_find)/.test(d));
      patch(a.id, { status: r.ok ? "done" : "fail", stage: "", heard: r.heard, last: r.say || r.heard, undo: changed ? since : undefined });
      say(a.id, r.say, changed ? 9000 : 6000);
      haptic(r.ok ? "tick" : "warn", 0.6);
      console.info(`[agent] ${r.engine} ${r.ms} ms: "${r.heard}" → ${r.did.join(", ") || "(no tools)"} → ${r.say}`);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      patch(a.id, { status: "fail", stage: "" });
      say(a.id, e instanceof Error ? e.message : String(e), 8000);
    } finally {
      window.clearInterval(tick);
      patch(a.id, { secs: 0 });
      cursorFx({ key: actor, phase: "done" });
    }
  };
  /** First tap: record until the next tap (no guessing when you're done). */
  // The voice level per bubble, for its recording cloud.
  const levels = useRef(new Map<string, { current: number }>());
  const levelOf = (id: string) => {
    let r = levels.current.get(id);
    if (!r) levels.current.set(id, (r = { current: 0 }));
    return r;
  };
  const goLive = async (a: Agent) => {
    // One microphone: another bubble's recording is sent as its request.
    for (const other of [...mics.current.keys()]) {
      const b = agentsRef.current.find((x) => x.id === other);
      if (other !== a.id) void (b ? submit(b) : stopLive(other));
    }
    if (mics.current.has(a.id)) return;
    const m: { pcm: PcmRecording | null; cancelled?: boolean } = { pcm: null };
    mics.current.set(a.id, m);
    const brain = brainOf(a);
    brain.begin();
    patch(a.id, { live: true, heard: "", ear: "🎙️ Listening… tap when done", say: "", stage: "", undo: undefined });
    haptic("press", 0.8);
    try {
      const pcm = await recordPcm(
        (level) => {
          levelOf(a.id).current = level;
          // The ring round the bubble swells with the voice (no re-render: a CSS variable).
          levelEl(a.id)?.style.setProperty("--lvl", Math.min(1, level * 4).toFixed(2));
        },
        (chunk) => brain.audio(chunk),
      );
      // Tapped again (or dropped) while the microphone was starting.
      if (m.cancelled) return pcm.cancel();
      m.pcm = pcm;
    } catch (e) {
      mics.current.delete(a.id);
      brain.cancel();
      patch(a.id, { live: false, ear: "" });
      say(a.id, `Can't use the microphone: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  };
  useEffect(
    () => () => {
      for (const m of mics.current.values()) m.pcm?.cancel();
      mics.current.clear();
      for (const b of brains.current.values()) b.close();
      brains.current.clear();
    },
    [],
  );
  const undo = async (a: Agent) => {
    if (!a.undo) return;
    haptic("press", 0.7);
    const n = await undoSince(store, actorOf(a), a.undo).catch(() => 0);
    patch(a.id, { undo: undefined });
    say(a.id, n ? "↩ Put back as it was" : "Changed since, left it", 3000);
    if (!n) showToast("That note changed after the agent's edit; undo it in Settings › AI changes", "info");
  };

  const statusFor = useRef(new Map<string, (s: AgentStatus, last: string) => void>());
  const onStatus = (id: string) => {
    let f = statusFor.current.get(id);
    if (!f) {
      f = (status, last) =>
        setAgents((list) =>
          list.map((a) => {
            if (a.id !== id || (a.status === status && a.last === last)) return a;
            // Anything new while it's folded away gets a dot on the bubble.
            const changed = a.status !== status && openRef.current !== id && (status === "done" || status === "fail" || status === "ask");
            return { ...a, status, last, unseen: a.unseen || changed };
          }),
        );
      statusFor.current.set(id, f);
    }
    return f;
  };

  if (!agents.length) return null;
  return createPortal(
    <div className="agents" ref={hostRef}>
      {agents.map((a) => (
        <Bubble
          key={a.id}
          agent={a}
          open={open === a.id}
          unseen={a.unseen && open !== a.id}
          onTap={() => {
            haptic("tap", 0.5);
            patch(a.id, { unseen: false });
            // Tap: yes to its question; else live on or off (its chat, if open, folds).
            const answer = asks.current.get(a.id);
            if (answer) return answer(true);
            if (a.status === "ask") {
              window.dispatchEvent(new CustomEvent(AGENT_ANSWER, { detail: { key: a.id, yes: true } }));
              return say(a.id, "OK, doing it", 1500);
            }
            if (open === a.id) return setOpen(null);
            if (mics.current.has(a.id)) void submit(a);
            else void goLive(a);
          }}
          onHold={() => {
            haptic("press", 1);
            // Hold: no to its question.
            const answer = asks.current.get(a.id);
            if (answer) return answer(false);
            stopLive(a.id);
            setOpen((o) => (o === a.id ? null : a.id));
            patch(a.id, { unseen: false });
          }}
          onMove={(x, y) => patch(a.id, { x, y })}
          onNear={setNearHome}
          onDrop={(at, from) => {
            if (!at) return;
            stopLive(a.id);
            merge(a, at, from);
          }}
        />
      ))}
      {agents.map((a) =>
        a.live && !a.gone && open !== a.id ? (
          // 25 Nov: a little glass cloud comes out of the bubble while it records; the words form
          // in it as they're heard. Tap it (or the bubble) when you're done.
          <button
            key={`v${a.id}`}
            type="button"
            className={`agent-cloud${a.x > window.innerWidth / 2 ? " left" : ""}`}
            style={{ left: a.x, top: a.y } as CSSProperties}
            onClick={() => void submit(a)}
            aria-label="Done talking: send it"
          >
            <VoicePill className="agent-cloud-wave" level={levelOf(a.id)} text={a.heard ?? ""} placeholder="Listening…" mode="listening" />
            <small>{a.ear || "Tap when done"}</small>
          </button>
        ) : (a.stage || a.say) && !a.gone && open !== a.id ? (
          // What it heard, what it's doing, what it did (no chat panel). ↩ puts it back.
          <div
            key={`c${a.id}`}
            className={`agent-caption${a.x > window.innerWidth / 2 ? " left" : ""}${a.stage ? " busy" : ""}${a.status === "fail" ? " bad" : ""}`}
            style={{ left: a.x, top: a.y } as CSSProperties}
            aria-live="polite"
          >
            {a.heard ? <i>“{a.heard}”</i> : null}
            {a.stage ? (
              <small className="agent-ear">
                {a.stage}
                {(a.secs ?? 0) >= 2 ? <b className="agent-secs"> {a.secs}s</b> : null}
              </small>
            ) : a.say ? (
              <span className="agent-said">
                {a.say}
                {a.undo ? (
                  <button type="button" className="agent-undo" onClick={() => void undo(a)} aria-label="Put it back as it was">
                    ↩
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null,
      )}
      {agents.map((a) => (
        // The chat opens just under its bubble (or near the top when the bubble sits low).
        <div key={a.id} className="agent-slot" style={{ "--agent-top": `${a.y < window.innerHeight * 0.5 ? a.y + 36 : 72}px` } as CSSProperties}>
        <CommandBar
          key={a.id}
          store={store}
          request={{ mode: "type" }}
          onClose={() => remove(a.id)}
          agent={{
            key: a.id,
            actor: a.n === 1 ? ASSISTANT_ACTOR : `${ASSISTANT_ACTOR} ${a.n}`,
            name: `Agent ${a.n}`,
            open: open === a.id && !a.merging,
            onCollapse: () => setOpen(null),
            onStatus: onStatus(a.id),
          }}
        />
        </div>
      ))}
    </div>,
    document.body,
  );
}

function Bubble({ agent, open, unseen, onTap, onHold, onMove, onNear, onDrop }: {
  agent: Agent;
  open: boolean;
  unseen: boolean;
  onTap: () => void;
  onHold: () => void;
  onMove: (x: number, y: number) => void;
  onNear: (near: boolean) => void;
  onDrop: (home: { x: number; y: number } | null, from: { x: number; y: number }) => void;
}) {
  const drag = useRef<{ id: number; dx: number; dy: number; x0: number; y0: number; moved: boolean; near: boolean; home: { x: number; y: number } | null; held?: boolean; hold?: number } | null>(null);
  const el = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const x = agent.merging?.x ?? pos?.x ?? agent.x;
  const y = agent.merging?.y ?? pos?.y ?? agent.y;
  return (
    <button
      ref={el}
      type="button"
      className={`agent-bubble s-${agent.status}${agent.live ? " live" : ""}${open ? " open" : ""}${unseen ? " unseen" : ""}${agent.merging ? " merging" : ""}${agent.gone ? " gone" : ""}${drag.current?.near ? " near" : ""}${pos ? " dragging" : ""}`}
      style={{ left: x, top: y }}
      data-agent-key={agent.id}
      aria-label={`Agent ${agent.n}${agent.last ? `: ${agent.last}` : ""} (tap: listen or stop; hold: chat; drag onto Home: close)`}
      title={agent.last || `Agent ${agent.n}`}
      onPointerDown={(e) => {
        if (agent.merging) return;
        try {
          el.current?.setPointerCapture(e.pointerId);
        } catch {
          // Already up.
        }
        const d = (drag.current = { id: e.pointerId, dx: e.clientX - agent.x, dy: e.clientY - agent.y, x0: e.clientX, y0: e.clientY, moved: false, near: false, home: null } as NonNullable<typeof drag.current>);
        // Held still: the chat.
        d.hold = window.setTimeout(() => {
          if (drag.current === d && !d.moved) {
            d.held = true;
            onHold();
          }
        }, HOLD_MS);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return;
        if (!d.moved) {
          d.moved = true;
          window.clearTimeout(d.hold);
          document.documentElement.classList.add("agent-dragging");
          d.home = homeCenter();
          haptic("press", 0.6);
        }
        const p = { x: e.clientX - d.dx, y: e.clientY - d.dy };
        setPos(p);
        // Its busy arrows come along (AgentCursors).
        window.dispatchEvent(new Event(BUBBLE_MOVED));
        const near = !!d.home && Math.hypot(p.x - d.home.x, p.y - d.home.y) < MERGE_R;
        if (near !== d.near) {
          d.near = near;
          onNear(near);
          if (near) haptic("tick", 0.9);
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        drag.current = null;
        window.clearTimeout(d.hold);
        document.documentElement.classList.remove("agent-dragging");
        setPos(null);
        window.dispatchEvent(new Event(BUBBLE_MOVED));
        if (d.held) return;
        if (!d.moved) return onTap();
        onNear(false);
        if (d.near && d.home) return onDrop(d.home, { x: e.clientX - d.dx, y: e.clientY - d.dy });
        const p = clampPos(e.clientX - d.dx, e.clientY - d.dy);
        onMove(p.x, p.y);
      }}
      onPointerCancel={() => {
        window.clearTimeout(drag.current?.hold);
        document.documentElement.classList.remove("agent-dragging");
        drag.current = null;
        setPos(null);
        onNear(false);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="agent-star" aria-hidden>✦</span>
      <span className="agent-n" aria-hidden>{agent.n}</span>
    </button>
  );
}

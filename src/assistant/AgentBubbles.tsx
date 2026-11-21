// Floating AI agents. Hold Home, draw it up into the top third of the screen and let go: a bubble
// floats there, an assistant of its own (the same one as ✦: chat, type or talk, long step lists,
// schedules). Do it again for another, each working on its own job at the same time. Tap a bubble
// to open or fold its chat; drag it back onto Home and it merges in and closes.
// Light on the battery: no timers or frames of its own; only CSS moves while a bubble is busy.
//
// Live (Hapi, 21 Nov: "like Gemini Live, no big chat"): a tap makes a bubble listen until it's
// tapped again; each sentence is done at once by the fastest model (live.ts) and its block is
// changed in place when corrected. Holding a bubble opens the old chat.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { haptic } from "../lib/haptic";
import { ASSISTANT_ACTOR } from "./runner";
import { AGENT_ANSWER, CommandBar, type AgentStatus } from "./CommandBar";
import { dismissBubble } from "./swarm/gone";
import { swarmOff } from "./swarm/run";
import { listenLive, type LiveEar } from "./listen";
import { liveTurn, type LiveCtx } from "./live";
import { BUBBLE_MOVED, cursorFx } from "./AgentCursors";

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
  say?: string;
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
  const lives = useRef(new Map<string, { ear: LiveEar | null; ctl: AbortController; chain: Promise<void> }>());
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
  const ctxs = useRef(new Map<string, LiveCtx>());
  const sayTimer = useRef(new Map<string, number>());
  const say = (id: string, text: string, ms = 5000) => {
    patch(id, { say: text });
    window.clearTimeout(sayTimer.current.get(id));
    if (text) sayTimer.current.set(id, window.setTimeout(() => patch(id, { say: "" }), ms));
  };
  const actorOf = (a: Agent) => (a.n === 1 ? ASSISTANT_ACTOR : `${ASSISTANT_ACTOR} ${a.n}`);
  const stopLive = (id: string) => {
    const l = lives.current.get(id);
    if (!l) return;
    lives.current.delete(id);
    l.ear?.stop();
    patch(id, { live: false, heard: "" });
  };
  const turn = async (a: Agent, text: string, ctl: AbortController) => {
    const actor = actorOf(a);
    let ctx = ctxs.current.get(a.id);
    if (!ctx) ctxs.current.set(a.id, (ctx = { store, actor, last: null, said: [] }));
    patch(a.id, { status: "run", heard: text });
    cursorFx({ key: actor, phase: "think", anchor: `.agent-bubble[data-agent-key="${a.id}"]` });
    try {
      const r = await liveTurn(text, ctx, ctl.signal, (q) => askLive(a.id, q));
      patch(a.id, { status: r.ok ? "done" : "fail", heard: "", last: r.say || text });
      if (r.say) say(a.id, r.say);
      haptic(r.ok ? "tick" : "warn", 0.6);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      patch(a.id, { status: "fail", heard: "" });
      say(a.id, e instanceof Error ? e.message : String(e), 8000);
    } finally {
      cursorFx({ key: actor, phase: "done" });
    }
  };
  const goLive = async (a: Agent) => {
    // One live bubble at a time (one microphone).
    for (const other of [...lives.current.keys()]) if (other !== a.id) stopLive(other);
    if (lives.current.has(a.id)) return;
    const l = { ear: null as LiveEar | null, ctl: new AbortController(), chain: Promise.resolve() };
    lives.current.set(a.id, l);
    patch(a.id, { live: true, heard: "" });
    say(a.id, "Listening… tap to stop", 2600);
    haptic("press", 0.8);
    try {
      const ear = await listenLive(
        (text) => {
          // An open question is answered by voice too.
          const answer = asks.current.get(a.id);
          if (answer && /^(yes|yeah|yep|ok|okay|sure|do it|go ahead|haan|ha|ji)\b/i.test(text.trim())) return answer(true);
          if (answer && /^(no|nope|cancel|stop|don'?t|nahi|na)\b/i.test(text.trim())) return answer(false);
          patch(a.id, { heard: text });
          l.chain = l.chain.then(() => turn(a, text, l.ctl));
        },
        (heard) => lives.current.get(a.id) === l && patch(a.id, { heard }),
        (note) => say(a.id, note, 6000),
      );
      l.ear = ear;
      // Tapped off while the microphone was starting.
      if (lives.current.get(a.id) !== l) ear.stop();
    } catch (e) {
      lives.current.delete(a.id);
      patch(a.id, { live: false });
      say(a.id, `Can't listen: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  };
  useEffect(
    () => () => {
      for (const l of lives.current.values()) l.ear?.stop();
      lives.current.clear();
    },
    [],
  );

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
            if (lives.current.has(a.id)) {
              stopLive(a.id);
              say(a.id, "Stopped listening", 1600);
            } else void goLive(a);
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
        (a.live || a.say) && !a.gone && open !== a.id ? (
          // What it hears and what it did, in a small line by the bubble (no chat panel).
          <div
            key={`c${a.id}`}
            className={`agent-caption${a.x > window.innerWidth / 2 ? " left" : ""}`}
            style={{ left: a.x, top: a.y } as CSSProperties}
            aria-live="polite"
          >
            {a.heard ? <i>{a.heard}</i> : a.say ? <span>{a.say}</span> : null}
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

// Floating AI agents. Hold Home, draw it up into the top third of the screen and let go: a bubble
// floats there, an assistant of its own (the same one as ✦: chat, type or talk, long step lists,
// schedules). Do it again for another, each working on its own job at the same time. Tap a bubble
// to open or fold its chat; drag it back onto Home and it merges in and closes.
// Light on the battery: no timers or frames of its own; only CSS moves while a bubble is busy.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { JournalStore } from "../store";
import { haptic } from "../lib/haptic";
import { ASSISTANT_ACTOR } from "./runner";
import { CommandBar, type AgentStatus } from "./CommandBar";

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
}

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
      setOpen(id);
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
  const merge = (a: Agent, at: { x: number; y: number }) => {
    haptic("edge", 1);
    patch(a.id, { merging: at });
    document.documentElement.classList.add("agent-merged");
    window.setTimeout(() => document.documentElement.classList.remove("agent-merged"), 520);
    window.setTimeout(() => remove(a.id), 340);
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
    <div className="agents">
      {agents.map((a) => (
        <Bubble
          key={a.id}
          agent={a}
          open={open === a.id}
          unseen={a.unseen && open !== a.id}
          onTap={() => {
            haptic("tap", 0.5);
            setOpen((o) => (o === a.id ? null : a.id));
            patch(a.id, { unseen: false });
          }}
          onMove={(x, y) => patch(a.id, { x, y })}
          onNear={setNearHome}
          onDrop={(at) => (at ? merge(a, at) : undefined)}
        />
      ))}
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

function Bubble({ agent, open, unseen, onTap, onMove, onNear, onDrop }: {
  agent: Agent;
  open: boolean;
  unseen: boolean;
  onTap: () => void;
  onMove: (x: number, y: number) => void;
  onNear: (near: boolean) => void;
  onDrop: (home: { x: number; y: number } | null) => void;
}) {
  const drag = useRef<{ id: number; dx: number; dy: number; x0: number; y0: number; moved: boolean; near: boolean; home: { x: number; y: number } | null } | null>(null);
  const el = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const x = agent.merging?.x ?? pos?.x ?? agent.x;
  const y = agent.merging?.y ?? pos?.y ?? agent.y;
  return (
    <button
      ref={el}
      type="button"
      className={`agent-bubble s-${agent.status}${open ? " open" : ""}${unseen ? " unseen" : ""}${agent.merging ? " merging" : ""}${drag.current?.near ? " near" : ""}${pos ? " dragging" : ""}`}
      style={{ left: x, top: y }}
      aria-label={`Agent ${agent.n}${agent.last ? `: ${agent.last}` : ""} (tap: open or fold; drag onto Home: close)`}
      title={agent.last || `Agent ${agent.n}`}
      onPointerDown={(e) => {
        if (agent.merging) return;
        try {
          el.current?.setPointerCapture(e.pointerId);
        } catch {
          // Already up.
        }
        drag.current = { id: e.pointerId, dx: e.clientX - agent.x, dy: e.clientY - agent.y, x0: e.clientX, y0: e.clientY, moved: false, near: false, home: null };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return;
        if (!d.moved) {
          d.moved = true;
          d.home = homeCenter();
          haptic("press", 0.6);
        }
        const p = { x: e.clientX - d.dx, y: e.clientY - d.dy };
        setPos(p);
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
        setPos(null);
        if (!d.moved) return onTap();
        onNear(false);
        if (d.near && d.home) return onDrop(d.home);
        const p = clampPos(e.clientX - d.dx, e.clientY - d.dy);
        onMove(p.x, p.y);
      }}
      onPointerCancel={() => {
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

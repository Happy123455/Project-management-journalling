// Item 12: 🎙 Talk + type. One box to type in and talk into at the same time (speech lands at the
// cursor while typing carries on), a graph beside it that grows as the explanation does, and
// "Make my prompt" at the end. It's a block in a note, so the session is in the journal and syncs;
// days later it opens with the text, the graph and what was left unfinished highlighted.
import { useEffect, useMemo, useRef, useState } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { graphFor, layoutGraph, makeMyPrompt, parseGraph, worthUpdating, type TalkGraph } from "../ai/talkGraph";
import { canListen, startListening, type Listening } from "../assistant/listen";
import { VoicePill } from "../talk/VoicePill";
import { fx } from "../lib/fx";
import { ImproveSheet } from "./ImproveSheet";

const SAVE_MS = 1500;
const KIND_ICON = { topic: "◎", idea: "💡", task: "☐", question: "?", decision: "◆" } as const;

function GraphPane({ graph, busy }: { graph: TalkGraph; busy: boolean }) {
  const W = 340;
  const H = 260;
  const pos = useMemo(() => layoutGraph(graph, W, H), [graph]);
  if (!graph.nodes.length) return <div className="talk-graph empty">{busy ? "Drawing…" : "The graph forms here as you explain."}</div>;
  return (
    <div className={`talk-graph${busy ? " busy" : ""}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="What you've explained so far, as a graph">
        {graph.edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          return a && b ? <line key={`${e.from}-${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="talk-edge" /> : null;
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const label = n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label;
          return (
            <g key={n.id} className={`talk-node ${n.kind} ${n.state}`} transform={`translate(${p.x},${p.y})`}>
              <rect x={-label.length * 3.1 - 14} y={-11} width={label.length * 6.2 + 28} height={22} rx={11} />
              <text textAnchor="middle" dy="4">
                {KIND_ICON[n.kind]} {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function TalkView({ node, updateAttributes, editor }: NodeViewProps) {
  const a = node.attrs as { sid: string; title: string; text: string; graph: string; prompt: string; updated: number };
  const [draft, setDraft] = useState(a.text);
  const [graph, setGraph] = useState<TalkGraph>(() => parseGraph(a.graph));
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState<Listening | null>(null);
  const [note, setNote] = useState("");
  const [making, setMaking] = useState(false);
  const [back] = useState(() => !!a.text && Date.now() - (a.updated || 0) > 3600_000);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const area = useRef<HTMLTextAreaElement>(null);
  const editable = editor.isEditable;

  // Changes from elsewhere (sync, the other device) when not typing here.
  useEffect(() => {
    if (document.activeElement !== area.current && a.text !== draftRef.current) setDraft(a.text);
  }, [a.text]);
  useEffect(() => setGraph(parseGraph(a.graph)), [a.graph]);

  // Saved into the note after a pause (not each key: every save is a sync event).
  const saveTimer = useRef(0);
  const save = (patch: Record<string, unknown>) => updateAttributes({ ...patch, updated: Date.now() });
  const queueSave = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => draftRef.current !== a.text && save({ text: draftRef.current }), SAVE_MS);
  };
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // The graph: after a sentence ends (a short pause) or after a few quiet seconds, one at a time.
  const graphTimer = useRef(0);
  const lastGraphed = useRef(a.text);
  const inFlight = useRef(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const updateGraph = async () => {
    const text = draftRef.current;
    if (inFlight.current || !worthUpdating(text, lastGraphed.current)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const g = await graphFor(text, graphRef.current);
      lastGraphed.current = text;
      setGraph(g);
      save({ graph: JSON.stringify(g), text: draftRef.current });
      setNote("");
    } catch (e) {
      setNote(`Graph paused: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const queueGraph = (text: string) => {
    window.clearTimeout(graphTimer.current);
    graphTimer.current = window.setTimeout(() => void updateGraph(), /[.?!\n]\s*$/.test(text) ? 1200 : 4000);
  };
  useEffect(() => () => window.clearTimeout(graphTimer.current), []);

  const change = (text: string) => {
    setDraft(text);
    draftRef.current = text;
    queueSave();
    queueGraph(text);
  };

  // Speech goes in where the cursor was, and keeps its place while typing goes on elsewhere.
  const seg = useRef<{ start: number; text: string }>({ start: 0, text: "" });
  const talk = async () => {
    if (listening) {
      const l = listening;
      setListening(null);
      await l.stop();
      fx("stop");
      return;
    }
    const el = area.current;
    const at = el ? el.selectionEnd : draftRef.current.length;
    seg.current = { start: at, text: "" };
    setNote("");
    try {
      const l = await startListening(
        (said) => {
          const cur = draftRef.current;
          const s = seg.current;
          let i = s.text ? cur.indexOf(s.text, Math.max(0, s.start - 80)) : Math.min(s.start, cur.length);
          if (i < 0) i = cur.length;
          const before = cur.slice(0, i);
          const pad = said && before && !/\s$/.test(before) ? " " : "";
          const piece = said ? pad + said : "";
          const next = before + piece + cur.slice(i + s.text.length);
          seg.current = { start: i, text: piece };
          change(next);
        },
        (n) => setNote(n),
        { onLevel: (v) => (level.current = v) },
      );
      setListening(l);
      fx("start");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const level = useRef(0);
  const listenRef = useRef(listening);
  listenRef.current = listening;
  useEffect(() => () => listenRef.current?.cancel(), []);

  const open = graph.nodes.filter((n) => n.state === "open" && n.kind !== "topic" && (n.kind === "task" || n.kind === "question"));

  return (
    <NodeViewWrapper className="talk-box" data-drag-handle="">
      <div className="talk-head" contentEditable={false}>
        <span className="talk-icon">🎙</span>
        <input className="talk-title" value={a.title} placeholder="Talk + type: what's this about?" readOnly={!editable} onChange={(e) => updateAttributes({ title: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        {a.updated > 0 && <span className="hint talk-when">{new Date(a.updated).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      {back && (graph.unfinished.length > 0 || open.length > 0) && (
        <div className="talk-back" contentEditable={false}>
          <b>Where you left off</b>
          {graph.unfinished.map((u) => (
            <span key={u} className="talk-chip">{u}</span>
          ))}
          {open.slice(0, 6).map((n) => (
            <span key={n.id} className={`talk-chip ${n.kind}`}>
              {KIND_ICON[n.kind]} {n.label}
            </span>
          ))}
        </div>
      )}
      <div className="talk-panes">
        <div className="talk-write">
          <textarea
            ref={area}
            className="talk-text"
            value={draft}
            readOnly={!editable}
            placeholder="Type, and tap 🎙 to talk whenever you like: both go here."
            rows={Math.min(16, Math.max(5, draft.split("\n").length + 2))}
            onChange={(e) => change(e.target.value)}
            onBlur={() => {
              window.clearTimeout(saveTimer.current);
              if (draftRef.current !== a.text) save({ text: draftRef.current });
            }}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {listening && <VoicePill className="talkbox-cloud" level={level} text={seg.current.text} mode="listening" />}
          {(listening || note) && (
            <p className={`talk-note${listening ? " live" : ""}`}>
              {listening && <span className="cmd-dot" aria-hidden />}
              {listening ? "Listening: keep typing if you like" : ""}
              {note && <span className="hint"> {note}</span>}
            </p>
          )}
          {graph.unfinished.length > 0 && !back && <p className="talk-left hint">Still open: {graph.unfinished.join(" · ")}</p>}
        </div>
        <GraphPane graph={graph} busy={busy} />
      </div>
      <div className="talk-actions" contentEditable={false}>
        {canListen() && editable && (
          <button type="button" className={`cmd-mic${listening ? " on" : ""}`} onClick={() => void talk()} aria-label={listening ? "Stop talking" : "Talk"}>
            🎙
          </button>
        )}
        <button type="button" className="primary" disabled={!draft.trim()} onClick={() => (fx("open"), setMaking(true))}>
          ✨ Make my prompt
        </button>
        {a.prompt && (
          <button type="button" className="link" onClick={() => (fx("done"), void navigator.clipboard?.writeText(a.prompt))}>
            Copy last prompt
          </button>
        )}
      </div>
      {a.prompt && <pre className="talk-prompt">{a.prompt}</pre>}
      {making && (
        <ImproveSheet
          original={draft}
          title="✨ Make my prompt"
          improve={(t) => makeMyPrompt(t)}
          onClose={() => setMaking(false)}
          onKeep={(text) => {
            save({ prompt: text, text: draftRef.current });
            setMaking(false);
            fx("done");
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

const newSid = () => `ts${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const TalkBox = Node.create({
  name: "talkBox",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      sid: { default: "", parseHTML: (el) => el.getAttribute("data-sid") || newSid() },
      title: { default: "", parseHTML: (el) => el.getAttribute("data-title") ?? "" },
      text: { default: "", parseHTML: (el) => el.getAttribute("data-text") ?? el.textContent ?? "" },
      graph: { default: "", parseHTML: (el) => el.getAttribute("data-graph") ?? "" },
      prompt: { default: "", parseHTML: (el) => el.getAttribute("data-prompt") ?? "" },
      updated: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-updated") ?? 0) },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-talk-box]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    return ["div", mergeAttributes(HTMLAttributes, { "data-talk-box": "", "data-sid": a.sid, "data-title": a.title, "data-text": a.text, "data-graph": a.graph, "data-prompt": a.prompt, "data-updated": String(a.updated) }), a.text];
  },
  // Searched and counted as what was said and the prompt made from it.
  renderText({ node }) {
    return [node.attrs.title, node.attrs.text, node.attrs.prompt].filter(Boolean).join("\n");
  },
  addNodeView() {
    return ReactNodeViewRenderer(TalkView);
  },
});

export const newTalkBox = (title = "") => ({ type: "talkBox", attrs: { sid: newSid(), title } });

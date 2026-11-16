// Item 13: ▶ Do this. A block of jobs for the assistant, one per line (or one long sentence), run
// in turn with ▶, or on a schedule written in words ("every day at 9 pm"). The schedule runs on
// the device that set it; the last runs show under the block (kept on that device).
import { useEffect, useState, useSyncExternalStore } from "react";
import { mergeAttributes, Node, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ASSIST_EVENT, type AssistRequest } from "../assistant/CommandBar";
import { describeSchedule, nextRun, parseSchedule, type Schedule } from "../assistant/schedule";
import { loadScheduled, runsOf, SCHEDULE_EVENT, setScheduled, thisDevice } from "../assistant/scheduler";
import { fx } from "../lib/fx";
import { noteNameOf } from "./noteEdit";

const readSchedule = (s: unknown): Schedule | null => {
  try {
    const v = typeof s === "string" && s ? JSON.parse(s) : null;
    return v && typeof v.minute === "number" ? v : null;
  } catch {
    return null;
  }
};

let version = 0;
const subscribe = (f: () => void) => {
  const on = () => (version++, f());
  window.addEventListener(SCHEDULE_EVENT, on);
  return () => window.removeEventListener(SCHEDULE_EVENT, on);
};

function DoThisView({ node, updateAttributes, editor }: NodeViewProps) {
  const { bid, text, device } = node.attrs as { bid: string; text: string; device: string };
  const schedule = readSchedule(node.attrs.schedule);
  const [draft, setDraft] = useState(text);
  const [setting, setSetting] = useState(false);
  const [words, setWords] = useState("");
  const [showRuns, setShowRuns] = useState(false);
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => setDraft(text), [text]);
  const mine = !!schedule && device === thisDevice();
  const note = noteNameOf(editor);
  const editable = editor.isEditable;

  // This device runs it: keep its record in step with the block (text, schedule, where it is).
  useEffect(() => {
    if (!bid) return;
    const have = loadScheduled()[bid];
    if (mine && schedule && note) {
      if (!have || have.text !== text || JSON.stringify(have.schedule) !== JSON.stringify(schedule) || have.note !== note) setScheduled(bid, { note, text, schedule });
    } else if (have && !mine) setScheduled(bid, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, mine, text, node.attrs.schedule, note]);

  const parsed = words.trim() ? parseSchedule(words) : null;
  const runs = runsOf(bid);
  const next = schedule ? nextRun(schedule, new Date()) : null;
  const saveSchedule = () => {
    if (!parsed) return;
    updateAttributes({ schedule: JSON.stringify(parsed), device: thisDevice(), text: draft });
    if (note) setScheduled(bid, { note, text: draft, schedule: parsed });
    setSetting(false);
    fx("done");
  };
  const run = () => {
    const t = (draft || text).trim();
    if (!t) return;
    if (draft !== text) updateAttributes({ text: draft });
    fx("start");
    window.dispatchEvent(new CustomEvent<AssistRequest>(ASSIST_EVENT, { detail: { mode: "run", text: t, bid } }));
  };

  return (
    <NodeViewWrapper className="do-this" data-drag-handle="">
      <div className="do-this-head" contentEditable={false}>
        <span className="do-this-title">▶ Do this</span>
        {schedule && (
          <span className={`do-this-when${mine ? "" : " other"}`} title={mine ? "Runs on this device" : "Set on another device; it runs there"}>
            🕘 {describeSchedule(schedule)}
            {!mine && " · other device"}
            {mine && next && ` · next ${next.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`}
          </span>
        )}
      </div>
      <textarea
        className="do-this-text"
        value={draft}
        readOnly={!editable}
        placeholder={"One job per line, e.g.\nfind an unticked task and put it under Journal\nopen the first day of college in a new tab\nsummarise it in one paragraph and read it"}
        rows={Math.min(14, Math.max(2, draft.split("\n").length + 1))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== text && updateAttributes({ text: draft })}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="do-this-actions" contentEditable={false}>
        <button type="button" className="primary" disabled={!(draft || text).trim()} onClick={run}>
          ▶ Run
        </button>
        {editable && (
          <button type="button" onClick={() => (setSetting(!setting), setWords(""))} aria-expanded={setting}>
            🕘 {schedule ? "Change" : "Schedule"}
          </button>
        )}
        {editable && schedule && (
          <button
            type="button"
            className="link"
            onClick={() => {
              updateAttributes({ schedule: "", device: "" });
              setScheduled(bid, null);
              fx("stop");
            }}
          >
            Stop schedule
          </button>
        )}
        {runs.length > 0 && (
          <button type="button" className="link" onClick={() => setShowRuns(!showRuns)}>
            Last runs {showRuns ? "▴" : "▾"}
          </button>
        )}
      </div>
      {setting && (
        <div className="do-this-set" contentEditable={false}>
          <input
            autoFocus
            value={words}
            placeholder="every day at 9 pm · weekdays 7:30 · mon and thu 18:00 · tomorrow 8am"
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") saveSchedule();
            }}
          />
          <span className={`hint${words.trim() && !parsed ? " prompt-error" : ""}`}>{parsed ? `🕘 ${describeSchedule(parsed)}` : words.trim() ? "Not a time I can read yet" : "Write when, in words"}</span>
          <button
            type="button"
            className="primary"
            disabled={!parsed}
            onClick={saveSchedule}
          >
            Save
          </button>
        </div>
      )}
      {showRuns && (
        <ul className="do-this-runs" contentEditable={false}>
          {runs.map((r) => (
            <li key={r.at} className={r.ok ? "" : "fail"}>
              <b>{new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</b> {r.ok ? "✓" : "⚠"} {r.answer}
            </li>
          ))}
        </ul>
      )}
    </NodeViewWrapper>
  );
}

const newBid = () => `dt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DoThisBlock = Node.create({
  name: "doThis",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      bid: { default: "", parseHTML: (el) => el.getAttribute("data-bid") || newBid() },
      text: { default: "", parseHTML: (el) => el.getAttribute("data-text") ?? el.textContent ?? "" },
      schedule: { default: "", parseHTML: (el) => el.getAttribute("data-schedule") ?? "" },
      device: { default: "", parseHTML: (el) => el.getAttribute("data-device") ?? "" },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-do-this]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    return ["div", mergeAttributes(HTMLAttributes, { "data-do-this": "", "data-bid": a.bid, "data-text": a.text, "data-schedule": a.schedule, "data-device": a.device }), a.text];
  },
  renderText({ node }) {
    return `▶ ${node.attrs.text}`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(DoThisView);
  },
});

/** A new empty ▶ Do this block (the slash menu). */
export const newDoThis = () => ({ type: "doThis", attrs: { bid: newBid() } });

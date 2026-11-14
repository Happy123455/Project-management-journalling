import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/react";
import { buildNexus } from "./lib/nexus";
import { putBack, removedLines, type RemovedLine } from "./lib/removedLines";
import { showError, showToast } from "./lib/toast";
import { docText } from "./lib/words";
import type { JournalEvent, JournalStore } from "./store";

export type NexusTarget = { kind: "day"; day: string; blockId: string; title: string } | { kind: "page"; pageId: string; blockId: string; title: string };

const LANE = 96;
const ROW = 30;

export type NexusTab = "sync" | "send" | "history";

/**
 * ⑂ Nexus: everything between this device and the other one. Sync (status, connect, network
 * history), Send (text and files straight over Wi-Fi) and History (how this note changed across
 * devices, where two edited it at once, and a version to keep). Tapping the sync line opens it.
 */
export function NexusView({ store, target, tab: firstTab = "history", sync, send, onClose, onRestored }: {
  store: JournalStore;
  target: NexusTarget;
  tab?: NexusTab;
  sync: ReactNode;
  send: ReactNode;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [tab, setTab] = useState<NexusTab>(firstTab);
  const tabs: [NexusTab, string][] = [["sync", "☁︎ Sync"], ["send", "📤 Send"], ["history", "⑂ This note"]];
  return (
    <div className="settings-view nexus-view" role="dialog" aria-label="Nexus">
      <header className="graph-bar">
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
        <h1 className="settings-title">⑂ Nexus</h1>
      </header>
      <div className="nexus-tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === "sync" && <div className="nexus-sync">{sync}</div>}
      {tab === "send" && send}
      {tab === "history" && <NoteHistory store={store} target={target} onRestored={onRestored} />}
    </div>
  );
}

/** How a note changed across devices, where two edited it at once, and a version to keep. */
function NoteHistory({ store, target, onRestored }: { store: JournalStore; target: NexusTarget; onRestored: () => void }) {
  const [events, setEvents] = useState<JournalEvent[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    void store.eventsFor(target.blockId).then(setEvents);
  }, [store, target.blockId]);
  const nexus = useMemo(() => (events ? buildNexus(events) : null), [events]);
  const at = (id: string) => nexus?.nodes.find((n) => n.event.id === id);
  const chosen = picked ? at(picked) : null;
  const content = useMemo(() => {
    try {
      return chosen ? (JSON.parse(chosen.event.after) as JSONContent) : null;
    } catch {
      return null;
    }
  }, [chosen]);
  const latest = nexus?.nodes[nexus.nodes.length - 1]?.event.id;

  const keep = async () => {
    if (!content) return;
    try {
      const plainText = docText(content);
      if (target.kind === "day") await store.saveDay({ day: target.day, content, plainText });
      else await store.savePage({ id: target.pageId, content, plainText });
      showToast("Kept that version");
      onRestored();
    } catch (e) {
      showError("Couldn't keep that version", e);
    }
  };

  // Lines any edit or sync took out that aren't in the note now: each one can be put back.
  const [current, setCurrent] = useState<JSONContent | null>(null);
  const loadCurrent = () => {
    const got = target.kind === "day" ? store.getDay(target.day) : store.getPage(target.title);
    void got.then((pg) => setCurrent(pg?.content ?? null));
  };
  useEffect(loadCurrent, [store, target]);
  const removed = useMemo(() => (events && current ? removedLines(events, current) : []), [events, current]);
  const [showAll, setShowAll] = useState(false);
  const restoreLine = async (line: RemovedLine) => {
    const pg = target.kind === "day" ? await store.getDay(target.day) : await store.getPage(target.title);
    if (!pg) return;
    const content = putBack(pg.content, line);
    try {
      if (target.kind === "day") await store.saveDay({ day: target.day, content, plainText: docText(content) });
      else await store.savePage({ id: target.pageId, content, plainText: docText(content) });
      showToast("Put back");
      setCurrent(content);
      void store.eventsFor(target.blockId).then(setEvents);
      onRestored();
    } catch (e) {
      showError("Couldn't put it back", e);
    }
  };

  const x = (lane: number) => 48 + lane * LANE;
  const y = (row: number) => 24 + row * ROW;
  return (
    <div className="nexus-history">
      <h2 className="settings-label">{target.title}</h2>
      {removed.length > 0 && (
        <div className="nexus-removed">
          <p className="hint">🗑 {removed.length} line{removed.length === 1 ? "" : "s"} taken out of this note (by you, the other device or sync). Tap ↩ to put one back where it was.</p>
          {(showAll ? removed : removed.slice(0, 8)).map((r) => (
            <div key={r.id} className="nexus-removed-row">
              <span className="nexus-removed-meta">{new Date(r.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {r.deviceId.slice(0, 8)}{r.actor !== "me" ? ` · ${r.actor}` : ""}</span>
              <span className="nexus-removed-text">{r.text.slice(0, 200)}</span>
              <button type="button" onClick={() => void restoreLine(r)} aria-label="Put back">↩</button>
            </div>
          ))}
          {removed.length > 8 && !showAll && <button type="button" className="link" onClick={() => setShowAll(true)}>Show all {removed.length}</button>}
        </div>
      )}
      {!nexus ? (
        <p className="hint">Loading…</p>
      ) : (
        <div className="nexus-body">
          <p className="hint">
            {nexus.conflicts
              ? `${nexus.conflicts} time${nexus.conflicts === 1 ? "" : "s"} two devices edited this at once (orange). Tap a version to see it and keep it.`
              : "Every version of this note, one column per device. Tap one to see it, and keep it if you want it back."}
          </p>
          <div className="nexus-graph">
            <svg width={x(nexus.devices.length - 1) + 60} height={y(nexus.nodes.length - 1) + 30}>
              {nexus.devices.map((d, i) => (
                <text key={d} x={x(i)} y={12} textAnchor="middle" className="nexus-lane">{d.slice(0, 8)}</text>
              ))}
              {nexus.edges.map((e) => {
                const a = at(e.from)!;
                const b = at(e.to)!;
                return <line key={e.from + e.to} x1={x(a.lane)} y1={y(a.row)} x2={x(b.lane)} y2={y(b.row)} className="nexus-edge" />;
              })}
              {nexus.nodes.map((n) => (
                <circle
                  key={n.event.id}
                  cx={x(n.lane)}
                  cy={y(n.row)}
                  r={picked === n.event.id ? 9 : 6}
                  className={`nexus-node${n.concurrent ? " concurrent" : ""}${picked === n.event.id ? " picked" : ""}${n.event.actor !== "me" ? " ai" : ""}`}
                  onClick={() => setPicked(n.event.id)}
                >
                  <title>{new Date(n.event.createdAt).toLocaleString()} · {n.event.actor}</title>
                </circle>
              ))}
            </svg>
          </div>
          {chosen && (
            <div className="nexus-preview">
              <div className="settings-label">
                {new Date(chosen.event.createdAt).toLocaleString()} · {chosen.event.deviceId.slice(0, 8)} · {chosen.event.actor}
                {chosen.concurrent && " · edited at the same time as another device"}
              </div>
              <pre>{content ? docText(content).slice(0, 1200) : "(not a text version)"}</pre>
              <button type="button" onClick={() => void keep()} disabled={!content || chosen.event.id === latest}>
                {chosen.event.id === latest ? "This is the current version" : "Keep this version"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

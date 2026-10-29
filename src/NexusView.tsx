import { useEffect, useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { buildNexus } from "./lib/nexus";
import { showError, showToast } from "./lib/toast";
import { docText } from "./lib/words";
import type { JournalEvent, JournalStore } from "./store";

export type NexusTarget = { kind: "day"; day: string; blockId: string; title: string } | { kind: "page"; pageId: string; blockId: string; title: string };

const LANE = 96;
const ROW = 30;

/** ⑂ Nexus: how a note changed across devices, where two edited it at once, and a version to keep. */
export function NexusView({ store, target, onClose, onRestored }: { store: JournalStore; target: NexusTarget; onClose: () => void; onRestored: () => void }) {
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

  const x = (lane: number) => 48 + lane * LANE;
  const y = (row: number) => 24 + row * ROW;
  return (
    <div className="settings-view nexus-view" role="dialog" aria-label="Nexus">
      <header className="graph-bar">
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
        <h1 className="settings-title">⑂ {target.title}</h1>
      </header>
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

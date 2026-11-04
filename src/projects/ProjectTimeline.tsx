import React, { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MediaPeek, mediaItemsIn } from "../editor/MediaPeek";
import { dayColor, entryFor, gapDays, numberEntries, type ProjectEntry } from "../lib/projectDays";
import { skyAt } from "../lib/sky";
import { dayTitle, TIMESTAMP_RE } from "../lib/timestamp";
import { DocView } from "../pages/DocView";
import { Marquee } from "../ui/Marquee";
import { plainText } from "../lib/plainText";
import { copyText } from "../editor/codeBlock";
import { showToast } from "../lib/toast";

/** An entry as plain text (its box title line left out). */
const entryPlain = (e: { doc?: unknown[] }) => plainText((e.doc ?? []) as never, { dropBoxTitle: true });

/** ⧉: copies text, then says so on the button for a moment. */
function CopyButton({ text, label = "Copy" }: { text: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`entries-copy${done ? " copied" : ""}`}
      onClick={(ev) => {
        ev.stopPropagation();
        const t = text();
        if (!t.trim()) return showToast("Nothing to copy");
        void copyText(t).then(
          () => (setDone(true), window.setTimeout(() => setDone(false), 1400)),
          (err) => showToast(`Couldn't copy: ${err instanceof Error ? err.message : String(err)}`, "error"),
        );
      }}
    >
      {done ? "✓ Copied" : `⧉ ${label}`}
    </button>
  );
}
import type { JournalStore, NamedPage } from "../store";

const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const GAP_CAP = 60;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Mode = "timeline" | "note" | "table";
const MODE_KEY = "journal.entriesMode";
const loadMode = (): Mode => {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "note" || m === "table" ? m : "timeline";
  } catch {
    return "timeline";
  }
};

type Entry = ProjectEntry & { n: number };

/** When the entry was written: the first timestamp in it (Hapi's format), or null. */
export function entryTime(e: ProjectEntry): { date: Date; hour: number } | null {
  for (const line of e.lines) {
    // A fresh copy: the shared pattern is global and keeps its place between uses.
    for (const m of line.matchAll(new RegExp(TIMESTAMP_RE.source, "g"))) {
      // "✎ " + time is when an older day was edited, not when the entry was written.
      if (line.slice(Math.max(0, m.index! - 2), m.index) === "✎ ") continue;
      const [, d, month, y, , hh, mm, ss] = m;
      return { date: new Date(Number(y), MONTHS.indexOf(month), Number(d), Number(hh), Number(mm), Number(ss)), hour: Number(hh) };
    }
  }
  // No time written: when typing in the entry began (its first line remembers it, see blockBorn).
  const born = firstBorn(e.doc as BornBlock[] | undefined);
  if (born) {
    const date = new Date(born);
    if (!Number.isNaN(date.getTime())) return { date, hour: date.getHours() };
  }
  return null;
}

type BornBlock = { attrs?: { born?: string | null }; content?: BornBlock[] };
function firstBorn(blocks: BornBlock[] | undefined): string | null {
  for (const b of blocks ?? []) {
    if (typeof b.attrs?.born === "string") return b.attrs.born;
    const inner = firstBorn(b.content);
    if (inner) return inner;
  }
  return null;
}

interface Props {
  store: JournalStore;
  page: NamedPage;
  refreshKey?: unknown;
  onOpenDay: (day: string) => void;
  onOpenLink?: (title: string) => void;
  onOpenTag?: (tag: string) => void;
}

/**
 * A page's entries (every day that mentions it), three ways: the timeline (Day N rows that open,
 * with the days in between as dashes), Note (one continuous read, days split by a thin line) and
 * Table (time, Day N and a one-line ticker per entry; a tap opens the entry in a pop-up).
 */
export function ProjectTimeline({ store, page, refreshKey, onOpenDay, onOpenLink, onOpenTag }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [mode, setMode] = useState<Mode>(loadMode);
  useEffect(() => {
    let live = true;
    void store.references("wikilink", page.title).then((refs) => {
      const list = refs.flatMap((r) => (r.day ? [entryFor(r.day, r.content as never, page.title)] : [])).filter((e): e is ProjectEntry => !!e);
      if (live) setEntries(numberEntries(list));
    });
    return () => {
      live = false;
    };
  }, [store, page.title, refreshKey]);

  if (!entries?.length) return null;
  const pick = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Only a convenience.
    }
  };
  const links = { onOpenLink, onOpenTag };
  return (
    <section className="project-timeline">
      <div className="entries-head">
        <h2>Entries</h2>
        <CopyButton label="Copy all" text={() => entries.map((e) => `${dayTitle(e.day)} · Day ${e.n}\n${entryPlain(e)}`).join("\n\n")} />
        <div className="entries-modes" role="tablist" aria-label="Show entries as">
          {(["timeline", "note", "table"] as Mode[]).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => pick(m)}>
              {m === "timeline" ? "☰ Days" : m === "note" ? "📖 Note" : "▦ Table"}
            </button>
          ))}
        </div>
      </div>
      {mode === "timeline" && <Timeline entries={entries} onOpenDay={onOpenDay} {...links} />}
      {mode === "note" && <NoteMode entries={entries} onOpenDay={onOpenDay} {...links} />}
      {mode === "table" && <TableMode entries={entries} onOpenDay={onOpenDay} {...links} />}
    </section>
  );
}

type ViewProps = { entries: Entry[]; onOpenDay: (day: string) => void; onOpenLink?: (t: string) => void; onOpenTag?: (t: string) => void };

/** The first line of an entry, drawn (links as titles, chips, GIFs where they sit). */
function FirstLine({ e, ...links }: { e: Entry; onOpenLink?: (t: string) => void; onOpenTag?: (t: string) => void }) {
  const first = firstBlock(e);
  return first ? <DocView content={first} compact className="doc-line" {...links} /> : <span>{e.lines[0]?.trim()}</span>;
}

/** The entry's first line as a block of its own (a list keeps only its first item's line). */
function firstBlock(e: Entry) {
  let b = e.doc?.[0];
  while (b && /List$/.test(b.type ?? "")) {
    const item = b.content?.[0];
    b = item?.content?.find((c) => !/List$/.test(c.type ?? ""));
  }
  return b ?? null;
}

function Timeline({ entries, onOpenDay, ...links }: ViewProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [gapOpen, setGapOpen] = useState<string | null>(null);
  return (
    <>
      <p className="hint">Set an entry's day number in its Block info (ⓘ) as “Day”; the next entries count on from it.</p>
      <div className="timeline">
        {entries.map((e, i) => {
          const prev = entries[i - 1];
          const missing = prev ? gapDays(prev.day, e.day) : [];
          const key = `${prev?.day}-${e.day}`;
          return (
            <Fragment key={e.day}>
              {missing.length > 0 && (
                <button type="button" className="timeline-gap" onClick={() => setGapOpen(gapOpen === key ? null : key)} aria-label={`${missing.length} days without an entry`}>
                  <span className="timeline-dashes">
                    {missing.slice(0, GAP_CAP).map((d) => <i key={d} style={{ background: dayColor(d) }} />)}
                  </span>
                  {missing.length > GAP_CAP && <span className="timeline-more">+{missing.length - GAP_CAP}</span>}
                  {gapOpen === key && (
                    <span className="timeline-gap-label">
                      {missing.length + 1} days · {short(prev!.day)} → {short(e.day)}
                    </span>
                  )}
                </button>
              )}
              <div className={`timeline-row${open === e.day ? " open" : ""}`}>
                <button type="button" className="timeline-head" onClick={() => setOpen(open === e.day ? null : e.day)}>
                  <span className="timeline-n" style={{ borderColor: dayColor(e.day) }}>Day {e.n}</span>
                  <span className="timeline-date">{short(e.day)}</span>
                  <span className="timeline-first">
                    <FirstLine e={e} {...links} />
                  </span>
                </button>
                {open !== e.day && <MediaPeek items={mediaItemsIn((e.doc ?? []).slice(1) as never)} />}
                {open === e.day && (
                  <div className="timeline-body">
                    <DocView content={e.doc} {...links} />
                    <div className="entries-body-actions">
                      <button type="button" onClick={() => onOpenDay(e.day)}>Open {short(e.day)} ›</button>
                      <CopyButton text={() => entryPlain(e)} />
                    </div>
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </>
  );
}

/** One continuous read, oldest first: each day under a thin line with the day's name. */
function NoteMode({ entries, onOpenDay, ...links }: ViewProps) {
  return (
    <div className="entries-note">
      {entries.map((e) => (
        <section key={e.day}>
          <button type="button" className="entries-divider" onClick={() => onOpenDay(e.day)}>
            <span>{dayTitle(e.day)} · Day {e.n}</span>
          </button>
          <DocView content={e.doc} {...links} />
        </section>
      ))}
    </div>
  );
}

const timeLabel = (e: Entry) => {
  const t = entryTime(e);
  const date = t?.date ?? new Date(`${e.day}T12:00:00`);
  const d = date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "2-digit" } : {}) });
  return t ? `${d} · ${String(t.date.getHours()).padStart(2, "0")}:${String(t.date.getMinutes()).padStart(2, "0")}` : d;
};

/** Time, Day N and a one-line ticker; the row takes the sky's colour at the hour it was written. */
function TableMode({ entries, onOpenDay, ...links }: ViewProps) {
  const [shown, setShown] = useState<{ e: Entry; from: DOMRect } | null>(null);
  return (
    <>
      <table className="entries-table">
        <thead>
          <tr>
            <th>Written</th>
            <th>Day</th>
            <th>Entry</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const t = entryTime(e);
            const sky = t ? skyAt(t.date) : null;
            return (
              <tr
                key={e.day}
                tabIndex={0}
                style={sky ? ({ "--row-sky": sky.bg, "--row-fg": sky.fg } as React.CSSProperties) : undefined}
                className={sky ? `sky ts-${sky.phase}` : ""}
                onClick={(ev) => setShown({ e, from: (ev.currentTarget as HTMLElement).getBoundingClientRect() })}
                onKeyDown={(ev) => ev.key === "Enter" && setShown({ e, from: (ev.currentTarget as HTMLElement).getBoundingClientRect() })}
              >
                <td className="entries-when">{sky?.icon} {timeLabel(e)}</td>
                <td className="entries-n">Day {e.n}</td>
                <td className="entries-text">
                  <Marquee>
                    <span>{e.lines.map((l) => l.trim()).join("  ·  ").replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => b || a).replace(new RegExp(`(✎ )?${TIMESTAMP_RE.source}`, "g"), "").replace(/\s+/g, " ")}</span>
                  </Marquee>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown && <EntryPopup entry={shown.e} from={shown.from} onClose={() => setShown(null)} onOpenDay={onOpenDay} {...links} />}
    </>
  );
}

/** The entry, drawn read-only, growing out of its row. */
function EntryPopup({ entry, from, onClose, onOpenDay, ...links }: { entry: Entry; from: DOMRect; onClose: () => void; onOpenDay: (d: string) => void; onOpenLink?: (t: string) => void; onOpenTag?: (t: string) => void }) {
  const card = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    window.setTimeout(onClose, 200);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // The card starts at the row (scaled down to it) and grows to its place in the middle.
  const vw = window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const originX = from.left + from.width / 2 - vw / 2;
  const originY = from.top + from.height / 2 - vh / 2;
  const sky = entryTime(entry);
  return createPortal(
    <div className={`entry-popup-layer${closing ? " closing" : ""}`} onClick={close}>
      <div
        ref={card}
        className="entry-popup"
        role="dialog"
        aria-label={dayTitle(entry.day)}
        onClick={(e) => e.stopPropagation()}
        style={{ "--from-x": `${originX}px`, "--from-y": `${originY}px`, "--from-s": Math.min(1, from.width / Math.min(vw - 24, 560)) } as React.CSSProperties}
      >
        <header style={sky ? ({ "--row-sky": skyAt(sky.date).bg, "--row-fg": skyAt(sky.date).fg } as React.CSSProperties) : undefined}>
          <strong>Day {entry.n}</strong>
          <span>{timeLabel(entry)}</span>
          <button type="button" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="entry-popup-body">
          <DocView content={entry.doc} {...links} />
        </div>
        <footer>
          <button type="button" onClick={() => (onClose(), onOpenDay(entry.day))}>Open {dayTitle(entry.day)} ›</button>
          <CopyButton text={() => entryPlain(entry)} />
        </footer>
      </div>
    </div>,
    document.body,
  );
}

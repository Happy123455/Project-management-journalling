import { Fragment, useEffect, useState } from "react";
import { MediaPeek, mediaItemsIn } from "../editor/MediaPeek";
import { dayColor, entryFor, gapDays, numberEntries, type ProjectEntry } from "../lib/projectDays";
import type { JournalStore, NamedPage } from "../store";

const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const GAP_CAP = 60;

/** A project's entries as Day N rows (tap to expand), with the days in between drawn as dashes. */
export function ProjectTimeline({ store, page, refreshKey, onOpenDay }: { store: JournalStore; page: NamedPage; refreshKey?: unknown; onOpenDay: (day: string) => void }) {
  const [entries, setEntries] = useState<ReturnType<typeof numberEntries> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [gapOpen, setGapOpen] = useState<string | null>(null);
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
  return (
    <section className="project-timeline">
      <h2>Entries</h2>
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
                  <span className="timeline-first">{e.lines[0].trim()}</span>
                </button>
                <MediaPeek items={mediaItemsIn(e.blocks as never)} />
                {open === e.day && (
                  <div className="timeline-body">
                    {e.lines.map((l, j) => (
                      <p key={j} style={{ paddingLeft: `${(l.match(/^ */)![0].length / 2) * 14}px` }}>{l.trim()}</p>
                    ))}
                    <button type="button" onClick={() => onOpenDay(e.day)}>Open {short(e.day)} ›</button>
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

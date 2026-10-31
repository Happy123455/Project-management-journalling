import { useEffect, useRef, useState } from "react";
import { highlightParts, matchText, searchTerms, type LineMatch } from "../lib/search";
import { dayTitle } from "../lib/timestamp";
import type { SearchHit } from "../store";

const MAX_LINES = 5;

export interface SearchResult {
  hit: SearchHit;
  count: number;
  lines: LineMatch[];
}

/** Hits with their matching lines and counts. */
export function toResults(hits: SearchHit[], query: string): SearchResult[] {
  const terms = searchTerms(query);
  return hits.map((hit) => {
    const m = matchText(hit.kind === "file" ? hit.file.name : hit.text, terms);
    return { hit, count: m?.count ?? 0, lines: m?.lines ?? [] };
  });
}

/** Matches per day, for the calendars' yellow density view. */
export function countsByDay(results: SearchResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) if (r.hit.kind === "day" && r.hit.day) counts[r.hit.day] = r.count;
  return counts;
}

function Line({ line }: { line: LineMatch }) {
  return (
    <span className="search-line">
      {highlightParts(line).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

/** Search across every day, page, tag and file name; results grouped by where they are. */
export function SearchPanel({ query, onQuery, results, onPick, onClose }: {
  query: string;
  onQuery: (q: string) => void;
  results: SearchResult[] | null;
  /** `match` is the number of the first match in the tapped line, counting from the top of the note. */
  onPick: (hit: SearchHit, match: number) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(query);
  useEffect(() => input.current?.focus(), []);
  // Search as you type, after a short pause.
  useEffect(() => {
    const t = window.setTimeout(() => onQuery(draft), 200);
    return () => window.clearTimeout(t);
  }, [draft, onQuery]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Phone: the panel ends above the keyboard (the window itself doesn't shrink for it), so the
  // results are never hidden behind it.
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVisible(vv.offsetTop + vv.height);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  const total = results?.reduce((n, r) => n + Math.max(r.count, 1), 0) ?? 0;
  return (
    <>
      <div className="search-backdrop" onClick={onClose} />
      <div
        className="search-panel"
        role="dialog"
        aria-label="Search"
        style={visible ? { maxHeight: `max(160px, calc(${visible}px - max(10px, env(safe-area-inset-top)) - 12px))` } : undefined}
      >
        <div className="search-bar">
          <span aria-hidden>🔍</span>
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search days, pages, #tags, files…"
            aria-label="Search"
            enterKeyHint="search"
          />
          {draft && (
            <button type="button" className="search-clear" onClick={() => setDraft("")} aria-label="Clear search">✕</button>
          )}
          <button type="button" onClick={onClose}>Done</button>
        </div>
        {query.trim() && results && (
          <p className="search-summary">
            {results.length ? `${total} match${total === 1 ? "" : "es"} in ${results.length} place${results.length === 1 ? "" : "s"}` : "No matches"}
          </p>
        )}
        <ul className="search-results">
          {results?.map((r) => {
            const key = r.hit.kind === "file" ? r.hit.file.id : r.hit.blockId;
            const where = r.hit.kind === "file" ? `📎 ${r.hit.file.name}` : r.hit.day ? dayTitle(r.hit.day) : `📄 ${r.hit.title}`;
            return (
              <li key={key}>
                <div className="search-result" role="button" tabIndex={0} onClick={() => onPick(r.hit, 0)}>
                  <span className="search-where">
                    {where}
                    {r.count > 0 && <span className="search-count">{r.count}</span>}
                  </span>
                  {r.hit.kind !== "file" &&
                    r.lines.slice(0, MAX_LINES).map((l, i) => (
                      <span
                        key={i}
                        onClick={(e) => {
                          e.stopPropagation();
                          onPick(r.hit, r.lines.slice(0, i).reduce((n, x) => n + x.ranges.length, 0));
                        }}
                      >
                        <Line line={l} />
                      </span>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

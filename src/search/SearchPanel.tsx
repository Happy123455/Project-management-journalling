import { useEffect, useRef, useState } from "react";
import { highlightParts, matchText, searchTerms, type LineMatch } from "../lib/search";
import { dayTitle } from "../lib/timestamp";
import type { SearchHit } from "../store";
import { useEscapeToClose } from "../ui/useEscapeToClose";

const MAX_LINES = 5;
const RECENT_KEY = "journal.recentSearches";
type Filter = "all" | "day" | "page" | "file";
const loadRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.slice(0, 8) : [];
  } catch {
    return [];
  }
};
const remember = (q: string) => {
  const t = q.trim();
  if (t.length < 2) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([t, ...loadRecent().filter((x) => x !== t)].slice(0, 8)));
  } catch {
    // Only a convenience.
  }
};

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
  const [filter, setFilter] = useState<Filter>("all");
  const [recent, setRecent] = useState(loadRecent);
  const pick = (hit: SearchHit, match: number) => {
    remember(draft);
    onPick(hit, match);
  };
  useEffect(() => input.current?.focus(), []);
  // Search as you type, after a short pause.
  useEffect(() => {
    const t = window.setTimeout(() => onQuery(draft), 200);
    return () => window.clearTimeout(t);
  }, [draft, onQuery]);
  useEscapeToClose(onClose);

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

  const shown = results?.filter((r) => filter === "all" || r.hit.kind === filter) ?? null;
  const kinds = { day: 0, page: 0, file: 0 };
  for (const r of results ?? []) kinds[r.hit.kind]++;
  const total = shown?.reduce((n, r) => n + Math.max(r.count, 1), 0) ?? 0;
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
        {!draft.trim() && recent.length > 0 && (
          <div className="search-recent">
            <span>Recent</span>
            {recent.map((q) => (
              <button key={q} type="button" onClick={() => setDraft(q)}>{q}</button>
            ))}
            <button type="button" className="search-recent-clear" onClick={() => (localStorage.removeItem(RECENT_KEY), setRecent([]))} aria-label="Clear recent searches">✕</button>
          </div>
        )}
        {!draft.trim() && (
          <p className="hint search-tips">
            Tip: “quoted words” search a phrase, #tag finds a tag, [[Page finds mentions of a page. <b>line:(alphabet microsoft)</b> finds them on the same line,{" "}
            <b>section:(…)</b> under the same heading, <b>block:(…)</b> in the same paragraph. Folded blocks open by themselves at the match.
          </p>
        )}
        {!draft.trim() && (
          <div className="search-recent search-ops">
            {["line:()", "section:()", "block:()"].map((op) => (
              <button key={op} type="button" onClick={() => (setDraft(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}${op}`), window.setTimeout(() => {
                const el = input.current;
                if (el) (el.focus(), el.setSelectionRange(el.value.length - 1, el.value.length - 1));
              }, 0))}>{op}</button>
            ))}
          </div>
        )}
        {query.trim() && results && results.length > 0 && (
          <div className="search-filters" role="tablist">
            {(["all", "day", "page", "file"] as Filter[]).map((f) => {
              const n = f === "all" ? results.length : kinds[f];
              if (f !== "all" && !n) return null;
              return (
                <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "day" ? "Days" : f === "page" ? "Pages" : "Files"} <small>{n}</small>
                </button>
              );
            })}
          </div>
        )}
        {query.trim() && shown && (
          <p className="search-summary">
            {shown.length ? `${total} match${total === 1 ? "" : "es"} in ${shown.length} place${shown.length === 1 ? "" : "s"}` : "No matches"}
          </p>
        )}
        <ul className="search-results">
          {shown?.map((r) => {
            const key = r.hit.kind === "file" ? r.hit.file.id : r.hit.blockId;
            const where = r.hit.kind === "file" ? `📎 ${r.hit.file.name}` : r.hit.day ? dayTitle(r.hit.day) : `📄 ${r.hit.title}`;
            return (
              <li key={key}>
                <div className="search-result" role="button" tabIndex={0} onClick={() => pick(r.hit, 0)}>
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
                          pick(r.hit, r.lines.slice(0, i).reduce((n, x) => n + x.ranges.length, 0));
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

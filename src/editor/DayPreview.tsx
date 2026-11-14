import { useEffect, useState } from "react";
import type { JournalStore } from "../store";
import type { DayPage } from "../store/types";
import { loadYoutubeDay, youtubeLine, type YoutubeDay } from "../lib/youtubeDigest";

/**
 * The day's preview card at the top of its note: the Mac's one-or-two sentence summary of the day
 * and, when the YouTube tracker sent one, what was watched (useful vs entertainment, topics, the
 * useful videos). Folded to one line; tap to open.
 */
export function DayPreview({ store, day, refreshKey }: { store: JournalStore; day: string; refreshKey?: unknown }) {
  const [snippet, setSnippet] = useState<DayPage["props"]["snippet"] | null>(null);
  const [yt, setYt] = useState<YoutubeDay | null>(null);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent).detail === day && setTick((n) => n + 1);
    window.addEventListener("journal:snippet", on);
    window.addEventListener("journal:youtube-day", on);
    return () => {
      window.removeEventListener("journal:snippet", on);
      window.removeEventListener("journal:youtube-day", on);
    };
  }, [day]);
  useEffect(() => {
    let live = true;
    void Promise.all([store.getDay(day).catch(() => null), loadYoutubeDay(store, day).catch(() => null)]).then(([page, y]) => {
      if (!live) return;
      setSnippet(page?.props.snippet ?? null);
      setYt(y);
    });
    return () => {
      live = false;
    };
  }, [store, day, refreshKey, tick]);
  if (!snippet && !yt) return null;
  return (
    <div className={`day-preview${open ? " open" : ""}`} onClick={(e) => (e.stopPropagation(), setOpen(!open))} role="button" tabIndex={0} aria-expanded={open}>
      {snippet && <p className="dp-snippet">✨ {snippet.text}</p>}
      {yt && <p className="dp-yt">{youtubeLine(yt)}</p>}
      {open && yt && (
        <div className="dp-more">
          {yt.note && <p className="dp-note">{yt.note}</p>}
          {yt.usefulVideos.length > 0 && (
            <ul>
              {yt.usefulVideos.map((v) => (
                <li key={v.id}>
                  <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>🎓 {v.title}</a>
                  {v.channel && <small> · {v.channel}</small>}
                </li>
              ))}
            </ul>
          )}
          {yt.rising.length > 0 && <p className="dp-rising">Rising: {yt.rising.join(", ")}</p>}
        </div>
      )}
      {open && snippet && <small className="dp-by">Preview by {snippet.by}</small>}
    </div>
  );
}

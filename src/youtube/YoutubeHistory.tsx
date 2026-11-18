import { useEffect, useMemo, useRef, useState } from "react";
import type { JournalStore } from "../store";
import { docText } from "../lib/words";
import { showError, showToast } from "../lib/toast";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { openLink } from "../editor/linkCard";
import { askAi } from "../ai/client";
import { purposeLabel } from "../lib/youtubeDigest";
import {
  categoryOf, CATEGORY_IDS, LIKES_PAGE, likeLine, likeScores, likesFromText, parseHistory, watchMinutes, ytStats,
  type YtHistory, type YtLike, type YtWatch,
} from "../lib/ytHistory";

/**
 * 📺 YouTube history: import Takeout's "My Activity.json" (or the extension's export), then kinds
 * (tap one for its videos), channels, ❤ liked and "more like your likes". Likes go on the
 * "YouTube likes" page so the assistant can read what Hapi likes.
 */
export const YT_HISTORY_EVENT = "journal:youtube-history";
const FILE = "youtube-history.json";
const KINDS_KEY = "journal.ytChannelKinds";
const KEEP_DAYS = 120;
const LIKES_KEEP_DAYS = 365;

type Range = "month" | 7 | 14 | 21 | "all";
type Tab = "kinds" | "channels" | "liked" | "more";

const readKinds = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(KINDS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};
const mins = (m: number) => (m >= 90 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)} h` : `${Math.round(m)} min`);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function loadSaved(store: JournalStore): Promise<YtHistory | null> {
  const rec = await store.findFile(FILE);
  if (!rec) return null;
  const bytes = await store.fileBytes(rec.id);
  if (!bytes) return null;
  try {
    return parseHistory(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

async function loadLikesPage(store: JournalStore): Promise<YtLike[]> {
  const page = await store.getPage(LIKES_PAGE);
  return page ? likesFromText(docText(page.content)) : [];
}

async function saveLikesPage(store: JournalStore, likes: YtLike[]) {
  const page = await store.ensurePage(LIKES_PAGE);
  const lines = ["Videos Hapi ❤ liked in 📺 YouTube history. The assistant suggests more of these kinds.", ...likes.map(likeLine)];
  const content = { type: "doc", content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) };
  await store.savePage({ id: page.id, content, plainText: docText(content), actor: "me" });
}

export function YoutubeHistory({ store, onClose }: { store: JournalStore; onClose: () => void }) {
  useEscapeToClose(onClose);
  const [hist, setHist] = useState<YtHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ownLikes, setOwnLikes] = useState<YtLike[]>([]);
  const [kinds, setKinds] = useState<Record<string, string>>(readKinds);
  const [range, setRange] = useState<Range>("month");
  const [tab, setTab] = useState<Tab>("kinds");
  const [open, setOpen] = useState<{ kind?: string; channel?: string } | null>(null);
  const [video, setVideo] = useState<YtWatch | null>(null);
  const [shown, setShown] = useState(80);
  const pick = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([loadSaved(store), loadLikesPage(store)]).then(([h, l]) => {
      if (!live) return;
      setHist(h);
      setOwnLikes(l);
      setLoading(false);
    });
    return () => void (live = false);
  }, [store]);
  useEffect(() => setShown(80), [open, tab, range]);

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const parsed = parseHistory(JSON.parse(await file.text()));
      if (!parsed.watches.length) throw new Error("No watched videos in that file.");
      const newest = parsed.watches[parsed.watches.length - 1].at;
      const old = hist?.watches ?? [];
      const merged = new Map<string, YtWatch>();
      for (const w of [...old, ...parsed.watches]) if (w.at > newest - KEEP_DAYS * 86400000) merged.set(`${w.id}|${Math.round(w.at / 60000)}`, w);
      const likes = new Map<string, YtLike>();
      for (const l of [...(hist?.likes ?? []), ...parsed.likes]) if (!l.at || l.at > newest - LIKES_KEEP_DAYS * 86400000) likes.set(l.id, l);
      const next: YtHistory = { watches: [...merged.values()].sort((a, b) => a.at - b.at), likes: [...likes.values()] };
      await store.saveFile({ name: FILE, mime: "application/json", bytes: new TextEncoder().encode(JSON.stringify(next)) });
      setHist(next);
      showToast(`📺 ${next.watches.length} watches kept (last ${KEEP_DAYS} days), ${next.likes.length} likes`);
    } catch (e) {
      showError("Couldn't read that file", e);
    } finally {
      setBusy(false);
    }
  };

  const watches = useMemo(() => {
    const all = hist?.watches ?? [];
    if (!all.length || range === "all") return all;
    const end = all[all.length - 1].at;
    if (range === "month") {
      const d = new Date(end);
      const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      return all.filter((w) => w.at >= from);
    }
    return all.filter((w) => w.at > end - range * 86400000);
  }, [hist, range]);
  const minutes = useMemo(() => watchMinutes(watches), [watches]);
  const minOf = useMemo(() => new Map(watches.map((w, i) => [w, minutes[i]])), [watches, minutes]);
  const stats = useMemo(() => ytStats(watches, kinds), [watches, kinds]);
  const likes = useMemo(() => {
    const m = new Map<string, YtLike>();
    for (const l of [...(hist?.likes ?? []), ...ownLikes]) m.set(l.id, l);
    return [...m.values()];
  }, [hist, ownLikes]);
  const ownIds = useMemo(() => new Set(ownLikes.map((l) => l.id)), [ownLikes]);
  const likedIds = useMemo(() => new Set(likes.map((l) => l.id)), [likes]);
  // Own ❤ count for more than the Takeout ones: they're what Hapi chose here.
  const scores = useMemo(() => likeScores(watches, [...ownLikes, ...ownLikes, ...(hist?.likes ?? []).slice(-300)], kinds), [watches, ownLikes, hist, kinds]);

  const toggleLike = async (w: YtWatch) => {
    const next = ownIds.has(w.id) ? ownLikes.filter((l) => l.id !== w.id) : [...ownLikes, { id: w.id, title: w.title, channel: w.channel, at: Date.now() }];
    setOwnLikes(next);
    try {
      await saveLikesPage(store, next);
    } catch (e) {
      showError("Couldn't save the like", e);
    }
  };
  const setChannelKind = (channel: string, kind: string) => {
    const next = { ...kinds };
    if (kind) next[channel.toLowerCase()] = kind;
    else delete next[channel.toLowerCase()];
    setKinds(next);
    try {
      localStorage.setItem(KINDS_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };

  // ✨ The channels the words couldn't place, sorted by the AI once (kept as channel kinds).
  const otherChannels = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const w of watches) if (w.channel && categoryOf(w, kinds) === "other") m.set(w.channel, [...(m.get(w.channel) ?? []), w.title].slice(0, 3));
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 80);
  }, [watches, kinds]);
  const sortWithAi = async () => {
    setBusy(true);
    try {
      const ids = CATEGORY_IDS.filter((x) => x !== "other");
      const r = await askAi<{ channels: { channel: string; kind: string }[] }>({
        task: "grammar",
        cloud: true,
        system: `Sort YouTube channels by why someone watches them, from the channel name and a few of its video titles. Kinds: ${ids.join(", ")}, other (only when truly unclear). Reply as JSON {"channels":[{"channel","kind"}]} with every channel given, its name exactly as given.`,
        text: otherChannels.map(([c, t]) => `${c}: ${t.join(" | ")}`).join("\n"),
        schema: { type: "object", properties: { channels: { type: "array", items: { type: "object", properties: { channel: { type: "string" }, kind: { type: "string", enum: [...ids, "other"] } }, required: ["channel", "kind"] } } }, required: ["channels"] },
        maxTokens: 3000,
      });
      const next = { ...kinds };
      let n = 0;
      for (const c of r.json?.channels ?? []) if (c.channel && c.kind && c.kind !== "other") (next[c.channel.toLowerCase()] = c.kind), n++;
      setKinds(next);
      try {
        localStorage.setItem(KINDS_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      showToast(`✨ Sorted ${n} channels`);
    } catch (e) {
      showError("Couldn't sort them", e);
    } finally {
      setBusy(false);
    }
  };

  const list: YtWatch[] = useMemo(() => {
    if (open?.kind) return watches.filter((w) => categoryOf(w, kinds) === open.kind).reverse();
    if (open?.channel) return watches.filter((w) => (w.channel || "(no channel)").toLowerCase() === open.channel!.toLowerCase()).reverse();
    if (tab === "liked") return watches.filter((w) => likedIds.has(w.id)).reverse();
    if (tab === "more") return [...new Map(watches.filter((w) => scores.has(w.id)).map((w) => [w.id, w])).values()].sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
    return [];
  }, [open, tab, watches, kinds, likedIds, scores]);

  const maxDay = Math.max(1, ...stats.days.map((d) => d.n));
  const maxHour = Math.max(1, ...stats.hours);
  const from = watches[0]?.at;
  const to = watches[watches.length - 1]?.at;

  const row = (w: YtWatch, i: number) => (
    <li key={`${w.id}-${w.at}-${i}`}>
      <button type="button" className="yth-video" onClick={() => setVideo(w)}>
        <span className="yth-v-title">{w.short ? "▮ " : ""}{w.title}</span>
        <small>{w.channel || "—"} · {when(w.at)}{tab === "more" && !open ? ` · ${scores.get(w.id)!.toFixed(1)}` : ""}</small>
      </button>
      <button type="button" className={`yth-heart${likedIds.has(w.id) ? " on" : ""}`} aria-label={ownIds.has(w.id) ? "Unlike" : "Like"} aria-pressed={likedIds.has(w.id)} onClick={() => void toggleLike(w)}>
        {likedIds.has(w.id) ? "❤" : "♡"}
      </button>
    </li>
  );

  return (
    <>
      <div className="outline-backdrop" onClick={onClose} />
      <aside className="routine-panel yth-panel" role="dialog" aria-label="YouTube history">
        <header>
          <strong>📺 YouTube</strong>
          <nav>
            {(["kinds", "channels", "liked", "more"] as Tab[]).map((t) => (
              <button key={t} type="button" className={tab === t && !open ? "active" : ""} onClick={() => (setTab(t), setOpen(null))}>
                {{ kinds: "Kinds", channels: "Channels", liked: "❤ Liked", more: "✨ More like" }[t]}
              </button>
            ))}
          </nav>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="routine-body yth-body">
          <input ref={pick} type="file" accept=".json,application/json" hidden onChange={(e) => (e.target.files?.[0] && void importFile(e.target.files[0]), (e.target.value = ""))} />
          {loading ? (
            <p className="routine-free">Loading…</p>
          ) : !hist ? (
            <div className="yth-empty">
              <p>Bring in your watch history: Google Takeout → YouTube → history, the file <b>My Activity.json</b> (or the extension's export).</p>
              <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{busy ? "Reading…" : "📥 Import history file"}</button>
            </div>
          ) : (
            <>
              <div className="trend-range yth-range">
                {(["month", 7, 14, 21, "all"] as Range[]).map((r) => (
                  <button key={r} type="button" className={range === r ? "active" : ""} onClick={() => setRange(r)}>
                    {r === "month" ? "This month" : r === "all" ? "All" : `${r} days`}
                  </button>
                ))}
                <button type="button" className="yth-import" disabled={busy} onClick={() => pick.current?.click()} title="Import a newer file">{busy ? "…" : "📥"}</button>
              </div>
              {from && <p className="routine-free yth-span">{new Date(from).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – {new Date(to!).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</p>}
              <div className="yth-cards">
                <div><b>{stats.videos}</b><small>videos</small></div>
                <div><b>{mins(stats.minutes)}</b><small>about</small></div>
                <div><b>{stats.days.length ? mins(stats.minutes / stats.days.length) : "—"}</b><small>a day</small></div>
                <div><b>{stats.channels.length}</b><small>channels</small></div>
              </div>

              {open ? (
                <>
                  <button type="button" className="yth-back" onClick={() => setOpen(null)}>‹ {open.kind ? purposeLabel(open.kind) : open.channel}</button>
                  <ul className="yth-list">{list.slice(0, shown).map(row)}</ul>
                  {list.length > shown && <button type="button" className="yth-more" onClick={() => setShown((n) => n + 200)}>Show more ({list.length - shown})</button>}
                </>
              ) : tab === "kinds" ? (
                <>
                  <div className="yth-kinds">
                    {stats.categories.map((c) => (
                      <button key={c.id} type="button" className={`yth-kind k-${c.id}`} onClick={() => setOpen({ kind: c.id })}>
                        <span>{purposeLabel(c.id)}</span>
                        <b>{c.n}</b>
                        <small>{mins(c.minutes)} · {Math.round((c.n / Math.max(1, stats.videos)) * 100)}%</small>
                        <i style={{ width: `${(c.n / Math.max(1, stats.videos)) * 100}%` }} />
                      </button>
                    ))}
                  </div>
                  {otherChannels.length > 0 && (
                    <button type="button" className="yth-more" disabled={busy} onClick={() => void sortWithAi()}>
                      {busy ? "Sorting…" : `✨ Sort ${otherChannels.length} “other” channel${otherChannels.length === 1 ? "" : "s"} with AI`}
                    </button>
                  )}
                  <h3>Each day</h3>
                  <div className="yth-days" role="img" aria-label="Videos each day">
                    {stats.days.map((d) => (
                      <span key={d.day} title={`${d.day}: ${d.n} videos, ${mins(d.minutes)}`} style={{ height: `${(d.n / maxDay) * 100}%` }} />
                    ))}
                  </div>
                  <h3>Time of day</h3>
                  <div className="yth-days yth-hours" role="img" aria-label="Videos by hour">
                    {stats.hours.map((n, h) => (
                      <span key={h} title={`${h}:00 · ${n}`} style={{ height: `${(n / maxHour) * 100}%` }} />
                    ))}
                  </div>
                  <div className="yth-hour-axis"><small>0</small><small>6</small><small>12</small><small>18</small><small>23</small></div>
                </>
              ) : tab === "channels" ? (
                <ul className="yth-list">
                  {stats.channels.slice(0, shown).map((c) => (
                    <li key={c.channel}>
                      <button type="button" className="yth-video" onClick={() => setOpen({ channel: c.channel })}>
                        <span className="yth-v-title">{c.channel}</span>
                        <small>{c.n} videos · {mins(c.minutes)} · {purposeLabel(categoryOf({ title: "", channel: c.channel }, kinds))}</small>
                      </button>
                    </li>
                  ))}
                  {stats.channels.length > shown && <button type="button" className="yth-more" onClick={() => setShown((n) => n + 200)}>Show more</button>}
                </ul>
              ) : (
                <>
                  {tab === "more" && <p className="routine-free">Close to what you ❤: same channels first, then shared words and kinds.{!likes.length && " Tap ♡ on a few videos first."}</p>}
                  <ul className="yth-list">{list.slice(0, shown).map(row)}</ul>
                  {list.length > shown && <button type="button" className="yth-more" onClick={() => setShown((n) => n + 200)}>Show more ({list.length - shown})</button>}
                  {!list.length && tab === "liked" && <p className="routine-free">No liked videos in this range.</p>}
                </>
              )}
            </>
          )}
        </div>
        {video && (
          <div className="yth-sheet" role="dialog" aria-label="Video">
            <button type="button" className="yth-sheet-x" onClick={() => setVideo(null)} aria-label="Close">✕</button>
            <h4>{video.title}</h4>
            <p>{video.channel || "—"}</p>
            <p className="routine-free">Watched {when(video.at)} · about {mins(minOf.get(video) ?? 0)}{video.short ? " · Short" : ""}</p>
            <p className="routine-free">Watched {watches.filter((w) => w.id === video.id).length}× in this range · {watches.filter((w) => w.channel === video.channel).length} from this channel</p>
            <label className="yth-kind-pick">
              Kind for this channel
              <select value={kinds[video.channel.toLowerCase()] ?? ""} onChange={(e) => setChannelKind(video.channel, e.target.value)}>
                <option value="">Auto: {purposeLabel(categoryOf({ ...video, channel: video.channel }, {}))}</option>
                {CATEGORY_IDS.map((id) => (
                  <option key={id} value={id}>{purposeLabel(id)}</option>
                ))}
              </select>
            </label>
            <div className="yth-sheet-acts">
              <button type="button" className={`yth-heart big${likedIds.has(video.id) ? " on" : ""}`} onClick={() => void toggleLike(video)}>{likedIds.has(video.id) ? "❤ Liked" : "♡ Like"}</button>
              <button type="button" onClick={() => void openLink(`https://youtu.be/${video.id}`)}>▶ Open</button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

/** For the assistant: the kinds and channels Hapi ❤ (from the likes page), short. */
export async function likedSummary(store: JournalStore): Promise<string> {
  const likes = await loadLikesPage(store);
  if (!likes.length) return "";
  const kinds = readKinds();
  const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([x, n]) => `${x} (${n})`).join(", ");
  return `Liked YouTube kinds: ${count(likes.map((l) => purposeLabel(categoryOf(l, kinds))))}. Channels: ${count(likes.map((l) => l.channel).filter(Boolean))}.`;
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { showError } from "../lib/toast";
import { insertFiles } from "./attachments";
import { openVoiceRecorder } from "./VoiceRecorder";

interface KitItem {
  id: string;
  kind: "photo" | "gif" | "sound" | "greenscreen";
  name: string;
  file: string;
  thumb?: string | null;
  group?: string | null;
  /** Picker categories (scripts/import-meme-kit.mjs). */
  tags?: string[];
  /** As rated in the meme-kit dashboard (a number, stars or a word). */
  rating?: number | string | null;
  /** Sounds: length in seconds and a 48-bar loudness outline, digits 0–9. */
  duration?: number;
  wave?: string;
}

const RATING_WORDS: Record<string, number> = { never: 0, bad: 1, meh: 2, ok: 2, okay: 2, maybe: 2, fine: 2, good: 3, nice: 3, great: 4, love: 5, loved: 5, best: 5, top: 5, gold: 5, favourite: 5, favorite: 5, must: 5 };
/** A dashboard rating as 0–5 (null when unrated or unknown). */
export function ratingScore(r: KitItem["rating"]): number | null {
  if (r == null || r === "") return null;
  if (typeof r === "number") return r > 5 ? Math.round(r / 20) : r;
  const s = String(r).toLowerCase().trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(5, Number(s));
  const stars = (s.match(/★|⭐/g) ?? []).length;
  if (stars) return stars;
  return RATING_WORDS[s] ?? null;
}
const stars = (n: number) => "★".repeat(Math.max(0, Math.round(n)));

/** A sound as a pill: as wide as it is long, with its wave; tap plays it, + adds it. */
function SoundPill({ item, playing, progress, starred, busy, onPlay, onPick, onStar }: {
  item: KitItem; playing: boolean; progress: number; starred: boolean; busy: boolean; onPlay: () => void; onPick: () => void; onStar: () => void;
}) {
  const press = useLongPress(onStar);
  const { consumed, ...handlers } = press;
  const bars = (item.wave ?? "3".repeat(24)).split("").map(Number);
  const secs = item.duration ?? 2;
  return (
    <li className={playing ? "sound-pill playing" : "sound-pill"} style={{ "--secs": Math.min(secs, 12) } as React.CSSProperties}>
      <button type="button" className="sound-wave" {...handlers} onClick={() => !consumed() && onPlay()} aria-label={`Play ${item.name}`}>
        <svg viewBox={`0 0 ${bars.length * 3} 20`} preserveAspectRatio="none" aria-hidden>
          {bars.map((b, i) => (
            <rect key={i} x={i * 3} y={10 - (b + 1)} width={2} height={(b + 1) * 2} rx={1} className={playing && i / bars.length < progress ? "done" : ""} />
          ))}
        </svg>
        <span className="sound-label">
          {starred && <span className="meme-star">★</span>}
          {item.name}
          <span className="sound-secs">{secs.toFixed(secs < 10 ? 1 : 0)}s</span>
          {ratingScore(item.rating) ? <span className="meme-rating">{stars(ratingScore(item.rating)!)}</span> : null}
        </span>
      </button>
      <button type="button" className="sound-add" disabled={busy} onClick={onPick} aria-label={`Add ${item.name}`}>
        {busy ? "…" : "+"}
      </button>
    </li>
  );
}

const RECENT = "Recent";
const FAVOURITES = "★ Favourites";
const ALL = "All";
/** Recently picked and starred items, per device. */
const listKey = (which: "recent" | "favourites") => `dynamic-journal.meme-${which}`;
function readList(which: "recent" | "favourites"): string[] {
  try {
    return JSON.parse(localStorage.getItem(listKey(which)) ?? "[]");
  } catch {
    return [];
  }
}
function writeList(which: "recent" | "favourites", ids: string[]) {
  try {
    localStorage.setItem(listKey(which), JSON.stringify(ids));
  } catch {
    // Only a convenience.
  }
}

/** Long-press (or right-click) stars an item; a normal tap still picks it. */
function useLongPress(onLong: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  return {
    onPointerDown: () => {
      fired.current = false;
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLong();
      }, 500);
    },
    onPointerUp: () => window.clearTimeout(timer.current),
    onPointerLeave: () => window.clearTimeout(timer.current),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      if (!fired.current) onLong();
      fired.current = true;
    },
    /** True once if this tap was a long-press (so the click shouldn't pick). */
    consumed: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}

type Tab = "memes" | "sounds";

/** A button that picks on tap and stars on long-press. */
function Pickable({ onPick, onStar, children, ...rest }: { onPick: () => void; onStar: () => void; children: React.ReactNode; className: string; disabled?: boolean; title?: string }) {
  const press = useLongPress(onStar);
  const { consumed, ...handlers } = press;
  return (
    <button type="button" {...rest} {...handlers} onClick={() => !consumed() && onPick()}>
      {children}
    </button>
  );
}

/** Opens the meme kit at Memes ("/" Meme) or Sounds ("/" Sound). */
export function openMemeKit(editor: Editor, tab: Tab) {
  window.dispatchEvent(new CustomEvent("journal:meme-kit", { detail: { editor, tab } }));
}

const KIT = "/meme-kit/";
let index: Promise<KitItem[]> | null = null;
const loadIndex = () => (index ??= fetch(`${KIT}index.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []));

/** The built-in meme kit: photos, GIF clips and sounds. Picking one copies it into the journal's media. */
export function MemeKit() {
  const [open, setOpen] = useState<{ editor: Editor; tab: Tab } | null>(null);
  const [items, setItems] = useState<KitItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [category, setCategory] = useState(ALL);
  const [favourites, setFavourites] = useState<string[]>(() => readList("favourites"));
  const [recent, setRecent] = useState<string[]>(() => readList("recent"));
  const toggleFavourite = (id: string) => {
    const next = favourites.includes(id) ? favourites.filter((f) => f !== id) : [id, ...favourites];
    setFavourites(next);
    writeList("favourites", next);
  };
  const preview = useRef<HTMLAudioElement | null>(null);
  const [minRating, setMinRating] = useState(0);
  const [playingSound, setPlayingSound] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [playingClip, setPlayingClip] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen((e as CustomEvent<{ editor: Editor; tab: Tab }>).detail);
      setQuery("");
      setCategory(ALL);
      setPlayingClip(null);
      void loadIndex().then(setItems);
    };
    window.addEventListener("journal:meme-kit", onOpen);
    return () => window.removeEventListener("journal:meme-kit", onOpen);
  }, []);
  useEffect(() => () => {
    preview.current?.pause();
    setPlayingSound(null);
  }, [open]);

  const inTab = useMemo(() => (items ?? []).filter((i) => (open?.tab === "sounds" ? i.kind === "sound" : i.kind !== "sound")), [items, open?.tab]);
  /** The tab's categories, biggest first, after Recent and Favourites. */
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of inTab) for (const t of i.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tags = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => t !== "Other");
    if (counts.has("Other")) tags.push("Other");
    return [ALL, RECENT, FAVOURITES, ...tags];
  }, [inTab]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = inTab;
    if (category === RECENT) list = recent.map((id) => inTab.find((i) => i.id === id)).filter((i): i is KitItem => !!i);
    else if (category === FAVOURITES) list = favourites.map((id) => inTab.find((i) => i.id === id)).filter((i): i is KitItem => !!i);
    else if (category !== ALL) list = inTab.filter((i) => i.tags?.includes(category));
    if (minRating) list = list.filter((i) => (ratingScore(i.rating) ?? 0) >= minRating);
    // Best rated first (Recent and Favourites keep their own order).
    if (category !== RECENT && category !== FAVOURITES) list = [...list].sort((a, b) => (ratingScore(b.rating) ?? 0) - (ratingScore(a.rating) ?? 0));
    return q ? list.filter((i) => `${i.name} ${(i.tags ?? []).join(" ")}`.toLowerCase().includes(q)) : list;
  }, [inTab, category, query, recent, favourites, minRating]);
  /** The ratings this tab has, for the filter chips. */
  const ratings = useMemo(() => [...new Set(inTab.map((i) => ratingScore(i.rating)).filter((n): n is number => !!n))].sort((a, b) => b - a), [inTab]);

  if (!open) return null;
  const close = () => setOpen(null);

  const pick = async (item: KitItem) => {
    setBusy(item.id);
    try {
      const res = await fetch(KIT + item.file);
      const blob = await res.blob();
      const ext = item.file.split(".").pop();
      const stem = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      // Sounds are named "sound-…" so they show with a 🔊 instead of a 🎙.
      const prefix = { sound: "sound", gif: "gif", greenscreen: "greenscreen", photo: "meme" }[item.kind];
      const name = `${prefix}-${stem}.${ext}`;
      await insertFiles(open.editor, [new File([blob], name, { type: blob.type || (item.kind === "sound" ? "audio/mpeg" : "video/mp4") })]);
      const nextRecent = [item.id, ...recent.filter((r) => r !== item.id)].slice(0, 30);
      setRecent(nextRecent);
      writeList("recent", nextRecent);
      close();
    } catch (e) {
      showError("Couldn't add that", e);
    } finally {
      setBusy(null);
    }
  };

  const play = (item: KitItem) => {
    preview.current?.pause();
    if (playingSound === item.id) return setPlayingSound(null);
    const audio = new Audio(KIT + item.file);
    preview.current = audio;
    setPlayingSound(item.id);
    setProgress(0);
    audio.ontimeupdate = () => audio.duration && setProgress(audio.currentTime / audio.duration);
    audio.onended = () => setPlayingSound((p) => (p === item.id ? null : p));
    void audio.play();
  };

  return (
    <>
      <div className="search-backdrop" onClick={close} />
      <div className="search-panel meme-kit" role="dialog" aria-label="Meme kit">
        <div className="search-bar">
          <div className="panel-tabs" role="tablist">
            {(["memes", "sounds"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={open.tab === t} className={open.tab === t ? "active" : ""} onClick={() => setOpen({ ...open, tab: t })}>
                {t === "memes" ? "😂 Memes" : "🔊 Sounds"}
              </button>
            ))}
          </div>
          <button type="button" onClick={close} aria-label="Close">✕</button>
        </div>
        <div className="search-bar">
          <span aria-hidden>🔍</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={open.tab === "sounds" ? "Search sounds" : "Search memes"} />
        </div>
        <div className="meme-chips" role="tablist" aria-label="Categories">
          {chips.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={category === c} className={category === c ? "active" : ""} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        {ratings.length > 0 && (
          <div className="meme-chips meme-ratings" role="tablist" aria-label="Rating">
            <button type="button" className={minRating === 0 ? "active" : ""} onClick={() => setMinRating(0)}>Any rating</button>
            {ratings.map((r) => (
              <button key={r} type="button" className={minRating === r ? "active" : ""} onClick={() => setMinRating(r)}>
                {stars(r)}{r < 5 ? "+" : ""}
              </button>
            ))}
          </div>
        )}
        {(category === FAVOURITES || category === RECENT) && !shown.length && (
          <p className="hint">{category === FAVOURITES ? "Long-press anything to star it." : "Things you add show up here."}</p>
        )}
        {items && !items.length && <p className="hint">The meme kit isn't installed (run scripts/import-meme-kit.mjs).</p>}
        {open.tab === "sounds" ? (
          <ul className="meme-sounds">
            <li>
              <button type="button" onClick={() => (close(), openVoiceRecorder(open.editor, "sound"))}>🎙 Record your own sound…</button>
            </li>
            {shown.map((i) => (
              <SoundPill
                key={i.id}
                item={i}
                playing={playingSound === i.id}
                progress={progress}
                starred={favourites.includes(i.id)}
                busy={busy === i.id}
                onPlay={() => play(i)}
                onPick={() => void pick(i)}
                onStar={() => toggleFavourite(i.id)}
              />
            ))}
          </ul>
        ) : (
          <div className="meme-grid">
            {shown.map((i) => {
              const clip = i.kind === "gif" || i.kind === "greenscreen";
              const playing = playingClip === i.id;
              return (
                <div key={i.id} className={playing ? "meme-cell playing" : "meme-cell"}>
                  <Pickable className="meme-tile" onPick={() => void pick(i)} onStar={() => toggleFavourite(i.id)} disabled={!!busy} title={i.name}>
                    {playing ? (
                      // Plays right where it is, bigger and with its sound; tap it to add it.
                      <video className={i.kind === "greenscreen" ? "stacked" : ""} src={KIT + i.file} autoPlay loop playsInline />
                    ) : clip ? (
                      i.thumb ? <img src={KIT + i.thumb} alt="" loading="lazy" /> : <video src={KIT + i.file} muted preload="metadata" />
                    ) : (
                      <img src={KIT + i.file} alt="" loading="lazy" />
                    )}
                    {i.kind !== "photo" && !playing && <span className="meme-badge">{i.kind === "greenscreen" ? "🟩 CLIP" : "GIF"}</span>}
                    {favourites.includes(i.id) && <span className="meme-star">★</span>}
                    {ratingScore(i.rating) ? <span className="meme-rating">{stars(ratingScore(i.rating)!)}</span> : null}
                    <span className="meme-name">{busy === i.id ? "Adding…" : playing ? `Tap to add · ${i.name}` : i.name}</span>
                  </Pickable>
                  {clip && (
                    <button type="button" className="meme-clip-play" onClick={() => setPlayingClip(playing ? null : i.id)} aria-label={playing ? "Stop" : `Play ${i.name}`}>
                      {playing ? "■" : "▶"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

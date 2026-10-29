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

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen((e as CustomEvent<{ editor: Editor; tab: Tab }>).detail);
      setQuery("");
      setCategory(ALL);
      void loadIndex().then(setItems);
    };
    window.addEventListener("journal:meme-kit", onOpen);
    return () => window.removeEventListener("journal:meme-kit", onOpen);
  }, []);
  useEffect(() => () => preview.current?.pause(), [open]);

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
    return q ? list.filter((i) => `${i.name} ${(i.tags ?? []).join(" ")}`.toLowerCase().includes(q)) : list;
  }, [inTab, category, query, recent, favourites]);

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
    preview.current = new Audio(KIT + item.file);
    void preview.current.play();
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
              <li key={i.id}>
                <button type="button" className="meme-play" onClick={() => play(i)} aria-label={`Play ${i.name}`}>▶</button>
                <Pickable className="meme-sound-name" onPick={() => void pick(i)} onStar={() => toggleFavourite(i.id)} disabled={!!busy}>
                  {favourites.includes(i.id) && <span className="meme-star">★</span>}
                  {busy === i.id ? "Adding…" : i.name}
                </Pickable>
              </li>
            ))}
          </ul>
        ) : (
          <div className="meme-grid">
            {shown.map((i) => (
              <Pickable key={i.id} className="meme-tile" onPick={() => void pick(i)} onStar={() => toggleFavourite(i.id)} disabled={!!busy} title={i.name}>
                {i.kind === "gif" || i.kind === "greenscreen" ? (
                  i.thumb ? <img src={KIT + i.thumb} alt="" loading="lazy" /> : <video src={KIT + i.file} muted />
                ) : (
                  <img src={KIT + i.file} alt="" loading="lazy" />
                )}
                {i.kind !== "photo" && <span className="meme-badge">{i.kind === "greenscreen" ? "🟩 CLIP" : "GIF"}</span>}
                {favourites.includes(i.id) && <span className="meme-star">★</span>}
                <span className="meme-name">{busy === i.id ? "Adding…" : i.name}</span>
              </Pickable>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

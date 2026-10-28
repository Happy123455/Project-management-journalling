import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { showError } from "../lib/toast";
import { insertFiles } from "./attachments";
import { openVoiceRecorder } from "./VoiceRecorder";

interface KitItem {
  id: string;
  kind: "photo" | "gif" | "sound";
  name: string;
  file: string;
  thumb?: string | null;
  group?: string | null;
}

type Tab = "memes" | "sounds";

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
  const preview = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen((e as CustomEvent<{ editor: Editor; tab: Tab }>).detail);
      setQuery("");
      void loadIndex().then(setItems);
    };
    window.addEventListener("journal:meme-kit", onOpen);
    return () => window.removeEventListener("journal:meme-kit", onOpen);
  }, []);
  useEffect(() => () => preview.current?.pause(), [open]);

  const shown = useMemo(() => {
    if (!items || !open) return [];
    const q = query.trim().toLowerCase();
    return items.filter((i) => (open.tab === "sounds" ? i.kind === "sound" : i.kind !== "sound") && (!q || i.name.toLowerCase().includes(q)));
  }, [items, open, query]);

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
      const name = item.kind === "sound" ? `sound-${stem}.${ext}` : item.kind === "gif" ? `gif-${stem}.${ext}` : `meme-${stem}.${ext}`;
      await insertFiles(open.editor, [new File([blob], name, { type: blob.type || (item.kind === "sound" ? "audio/mpeg" : "video/mp4") })]);
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
        {items && !items.length && <p className="hint">The meme kit isn't installed (run scripts/import-meme-kit.mjs).</p>}
        {open.tab === "sounds" ? (
          <ul className="meme-sounds">
            <li>
              <button type="button" onClick={() => (close(), openVoiceRecorder(open.editor, "sound"))}>🎙 Record your own sound…</button>
            </li>
            {shown.map((i) => (
              <li key={i.id}>
                <button type="button" className="meme-play" onClick={() => play(i)} aria-label={`Play ${i.name}`}>▶</button>
                <button type="button" className="meme-sound-name" onClick={() => void pick(i)} disabled={!!busy}>
                  {busy === i.id ? "Adding…" : i.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="meme-grid">
            {shown.map((i) => (
              <button key={i.id} type="button" className="meme-tile" onClick={() => void pick(i)} disabled={!!busy} title={i.name}>
                {i.kind === "gif" ? (
                  i.thumb ? <img src={KIT + i.thumb} alt="" loading="lazy" /> : <video src={KIT + i.file} muted />
                ) : (
                  <img src={KIT + i.file} alt="" loading="lazy" />
                )}
                {i.kind === "gif" && <span className="meme-badge">GIF</span>}
                <span className="meme-name">{busy === i.id ? "Adding…" : i.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

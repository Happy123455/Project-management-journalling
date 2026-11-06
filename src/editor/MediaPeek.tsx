import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { JSONContent } from "@tiptap/react";
import { youtubeId } from "../lib/linkPreview";
import { showPhoto, useFileUrl } from "./attachments";

/** A piece of media in a note, as the small previews show it (never edited there, only played or opened). */
export type PeekItem =
  | { kind: "image" | "video" | "audio"; fileId: string; name: string }
  | { kind: "youtube"; url: string };

/** Photos, videos, voice notes and YouTube players in some blocks of a note, in order, each once. */
export function mediaItemsIn(nodes: JSONContent[] | JSONContent | null | undefined, limit = 6): PeekItem[] {
  const out: PeekItem[] = [];
  const seen = new Set<string>();
  const add = (key: string, item: PeekItem) => {
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(item);
  };
  const walk = (n: JSONContent) => {
    const a = n.attrs ?? {};
    if (n.type === "attachmentImage" && a.fileId) add(a.fileId, { kind: "image", fileId: a.fileId, name: a.name ?? "" });
    else if (n.type === "attachmentMedia" && a.fileId) add(a.fileId, { kind: a.kind === "audio" ? "audio" : "video", fileId: a.fileId, name: a.name ?? "" });
    else if ((n.type === "youtubeEmbed" || n.type === "linkCard") && a.url && youtubeId(a.url)) add(a.url, { kind: "youtube", url: a.url });
    n.content?.forEach(walk);
  };
  for (const n of Array.isArray(nodes) ? nodes : nodes ? [nodes] : []) walk(n);
  return out;
}

// Taps inside the strip play or open the media, not the card around it.
const keep = (e: MouseEvent) => e.stopPropagation();

/** True once the element has come near the screen (previews far down a list never load). */
function useNearScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const seen = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: "200px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [near]);
  return [ref, near] as const;
}

function FilePeek({ item }: { item: Extract<PeekItem, { fileId: string }> }) {
  const [ref, near] = useNearScreen<HTMLSpanElement>();
  const { url } = useFileUrl(near ? item.fileId : null, item.kind !== "image");
  if (!url) return <span ref={ref} className="peek-item peek-loading" />;
  if (item.kind === "image")
    return (
      <span className="peek-item" role="button" tabIndex={0} onClick={(e) => (keep(e), showPhoto(url))}>
        <img src={url} alt={item.name} loading="lazy" />
      </span>
    );
  if (item.kind === "audio")
    return (
      <span className="peek-item peek-audio" onClick={keep}>
        <audio src={url} controls preload="metadata" />
      </span>
    );
  return (
    <span className="peek-item" onClick={keep}>
      <video src={url} controls playsInline muted preload="metadata" />
    </span>
  );
}

function YoutubePeek({ url }: { url: string }) {
  const id = youtubeId(url)!;
  const [playing, setPlaying] = useState(false);
  return (
    <span className="peek-item peek-youtube" onClick={keep}>
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0&autoplay=1`}
          title="YouTube video"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <button type="button" onClick={() => setPlaying(true)} aria-label="Play video">
          <img src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="" loading="lazy" />
          <span className="peek-play">▶</span>
        </button>
      )}
    </span>
  );
}

/** A row of small, play-only previews of the media in a note's preview text. */
export function MediaPeek({ items }: { items: PeekItem[] }) {
  if (!items.length) return null;
  return (
    <span className="media-peek">
      {items.map((it) => (it.kind === "youtube" ? <YoutubePeek key={it.url} url={it.url} /> : <FilePeek key={it.fileId} item={it} />))}
    </span>
  );
}

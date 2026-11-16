// Item 10 (16 Nov): the real media in canvas cards. Each card with a photo, GIF, clip or file
// draws a small thumbnail, made once per file and kept (in memory, at most THUMB_MAX), and only
// once the card is on screen; two are made at a time, so panning across many stays smooth.
// The selected card opens a bigger peek above it: photos and GIFs at full size, clips with a ▶
// that plays right there, PDFs' first page and files by name. Tapping the peek opens the usual
// photo viewer, player, PDF viewer, or the device's own app for other files.
import { memo, useEffect, useRef, useState } from "react";
import type { CanvasMedia } from "../lib/canvas";
import { fileUrl, mediaUrl, openFile, readFileBytes, readFileRecord, showPdf, showPhoto } from "../editor/attachments";

const THUMB_PX = 64;
const THUMB_MAX = 240;
/** fileId → thumbnail data URL (null: none can be made, show the icon). */
const thumbs = new Map<string, Promise<string | null>>();

let running = 0;
const queue: (() => void)[] = [];
/** At most two thumbnails are made at once. */
function slot<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < 2) go();
    else queue.push(go);
  });
}

/** Draws `src` (an image or video frame) cropped to a square, as a small JPEG. */
function squareOf(src: CanvasImageSource, w: number, h: number): string | null {
  if (!w || !h) return null;
  const c = document.createElement("canvas");
  const px = THUMB_PX * Math.min(2, window.devicePixelRatio || 1);
  c.width = c.height = px;
  const side = Math.min(w, h);
  c.getContext("2d")?.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, px, px);
  try {
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    // A picture from another origin can't be read back.
    return null;
  }
}

async function imageThumb(id: string): Promise<string | null> {
  const img = new Image();
  img.decoding = "async";
  img.src = await fileUrl(id);
  await img.decode();
  return squareOf(img, img.naturalWidth, img.naturalHeight);
}

function frameOf(src: string, cross: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    if (cross) v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "metadata";
    v.playsInline = true;
    const done = (r: string | null) => {
      window.clearTimeout(t);
      v.removeAttribute("src");
      v.load();
      resolve(r);
    };
    const t = window.setTimeout(() => done(null), 8000);
    v.onloadeddata = () => (v.currentTime = Math.min(0.1, (v.duration || 1) / 2));
    v.onseeked = () => done(squareOf(v, v.videoWidth, v.videoHeight));
    v.onerror = () => done(null);
    v.src = src;
  });
}

async function videoThumb(id: string): Promise<string | null> {
  const src = await mediaUrl(id);
  const got = await frameOf(src, !src.startsWith("blob:"));
  if (got || src.startsWith("blob:")) return got;
  // Streamed from the app's file server and couldn't be read back: small clips are read whole.
  const rec = await readFileRecord(id);
  return rec && (rec.size ?? 0) < 25_000_000 ? frameOf(await fileUrl(id), false) : null;
}

async function pdfThumb(id: string): Promise<string | null> {
  const bytes = await readFileBytes(id);
  if (!bytes) return null;
  const { openPdf, drawPage } = await import("../editor/pdf");
  const doc = await openPdf(bytes);
  const c = document.createElement("canvas");
  await drawPage(doc, 1, c, THUMB_PX * 2);
  return squareOf(c, c.width, c.height);
}

/** The thumbnail for a piece of media (made once, then kept). */
export function thumbFor(m: CanvasMedia): Promise<string | null> {
  let t = thumbs.get(m.fileId);
  if (!t) {
    const make = m.type === "image" ? imageThumb : m.type === "video" ? videoThumb : m.type === "pdf" ? pdfThumb : null;
    t = make ? slot(() => make(m.fileId)).catch(() => null) : Promise.resolve(null);
    // A file that isn't here yet (still syncing) is tried again next time.
    t.then((v) => v === null && make && thumbs.get(m.fileId) === t && thumbs.delete(m.fileId));
    thumbs.set(m.fileId, t);
    if (thumbs.size > THUMB_MAX) thumbs.delete(thumbs.keys().next().value!);
  }
  return t;
}

const ICON: Record<CanvasMedia["type"], string> = { image: "🖼", video: "🎬", audio: "🎙", pdf: "📕", file: "📎" };

/** True once the element is near the screen (the canvas moves by transform, which this follows). */
function useOnScreen<T extends Element>(active: boolean) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !active || !el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, active]);
  return [ref, seen] as const;
}

/** The small square at the start of a media card. */
export const CardThumb = memo(function CardThumb({ media, on }: { media: CanvasMedia; on: boolean }) {
  const [ref, seen] = useOnScreen<HTMLSpanElement>(on);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!seen) return;
    let live = true;
    void thumbFor(media).then((t) => live && setSrc(t));
    return () => {
      live = false;
    };
  }, [seen, media.fileId]);
  return (
    <span ref={ref} className={`nc-thumb t-${media.type}`} aria-hidden>
      {src ? <img src={src} alt="" draggable={false} /> : <i>{ICON[media.type]}</i>}
      {media.type === "video" && !media.gif && <b className="nc-play">▶</b>}
    </span>
  );
});

/** Opens a piece of media in the app's usual viewer. */
async function openMedia(m: CanvasMedia) {
  if (m.type === "pdf") return showPdf(m.fileId);
  if (m.type === "file") return void openFile(m.fileId);
  if (m.type === "image") return showPhoto(await fileUrl(m.fileId));
  if (m.type === "video") return showPhoto(await mediaUrl(m.fileId), "video");
}

/** The bigger peek over the selected media card. */
export function MediaPeekCard({ media, x, y, width }: { media: CanvasMedia; x: number; y: number; width: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setPlaying(false);
    void thumbFor(media).then((t) => live && setThumb(t));
    if (media.type === "image") void fileUrl(media.fileId).then((u) => live && setUrl(u), () => {});
    return () => {
      live = false;
    };
  }, [media.fileId, media.type]);
  const play = async () => {
    if (!url) setUrl(await mediaUrl(media.fileId));
    setPlaying(true);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className={`nc-peek p-${media.type}`} style={{ left: x, top: y, width }} onPointerDown={stop} onClick={stop} onDoubleClick={stop}>
      {media.type === "image" && (
        <button type="button" className="nc-peek-open" onClick={() => void openMedia(media)} aria-label="Open the photo">
          {url ? <img src={url} alt={media.name} /> : thumb ? <img src={thumb} alt="" /> : <span className="nc-peek-icon">🖼</span>}
        </button>
      )}
      {(media.type === "video" || media.type === "audio") &&
        (playing && url ? (
          media.type === "video" ? (
            <video src={url} autoPlay controls={!media.gif} loop={media.gif} muted={media.gif} playsInline onDoubleClick={() => void openMedia(media)} />
          ) : (
            <audio src={url} autoPlay controls />
          )
        ) : (
          <button type="button" className="nc-peek-open" onClick={() => void play()} aria-label={`Play ${media.name}`}>
            {thumb ? <img src={thumb} alt="" /> : <span className="nc-peek-icon">{ICON[media.type]}</span>}
            <b className="nc-peek-play">▶</b>
          </button>
        ))}
      {(media.type === "pdf" || media.type === "file") && (
        <button type="button" className="nc-peek-open nc-peek-file" onClick={() => void openMedia(media)} aria-label={`Open ${media.name}`}>
          {thumb ? <img src={thumb} alt="" /> : <span className="nc-peek-icon">{ICON[media.type]}</span>}
          <span className="nc-peek-name">{media.name || "File"}</span>
        </button>
      )}
      {media.type === "video" && playing && (
        <button type="button" className="nc-peek-full" onClick={() => void openMedia(media)} aria-label="Full screen">⤢</button>
      )}
    </div>
  );
}

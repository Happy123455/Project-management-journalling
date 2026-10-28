import { useEffect, useState } from "react";
import { PhotoViewer } from "./PhotoViewer";

/** Shows a photo full screen (double-tap, or a tap in the Media panel), or plays a video full screen. */
export function PhotoHost() {
  const [open, setOpen] = useState<{ url: string; kind: "image" | "video" } | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => setOpen((e as CustomEvent<{ url: string; kind?: "image" | "video" }>).detail as { url: string; kind: "image" | "video" });
    window.addEventListener("journal:open-photo", onOpen);
    return () => window.removeEventListener("journal:open-photo", onOpen);
  }, []);
  if (!open) return null;
  if (open.kind === "video") {
    return (
      <div className="photo-viewer" role="dialog" aria-label="Video">
        <div className="photo-stage">
          <video src={open.url} controls autoPlay playsInline />
        </div>
        <button type="button" className="photo-close" onClick={() => setOpen(null)} aria-label="Close video">✕</button>
      </div>
    );
  }
  return <PhotoViewer url={open.url} onClose={() => setOpen(null)} />;
}

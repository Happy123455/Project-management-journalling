import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const time = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

/** Taps on media never focus the text (no keyboard), and the page doesn't move while it starts. */
function holdScroll() {
  const y = window.scrollY;
  const until = Date.now() + 800;
  const keep = () => {
    if (window.scrollY !== y) window.scrollTo(0, y);
    if (Date.now() < until) requestAnimationFrame(keep);
  };
  requestAnimationFrame(keep);
}
/** Leaves the text: the keyboard closes (or never opens) while media is being played. */
export function leaveText() {
  const active = document.activeElement as HTMLElement | null;
  if (active?.closest?.(".ProseMirror")) active.blur();
}
const noFocus = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
  e.preventDefault();
  e.stopPropagation();
  leaveText();
};

/** Inline audio: a small pill. Tapping plays it and grows into a player with a scrubber; it shrinks back when done. */
export function AudioPill({ src, icon }: { src: string; icon: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(0);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    holdScroll();
    setOpen(true);
    if (a.paused) void a.play();
    else a.pause();
  };
  return (
    <span className={`audio-pill${open ? " open" : ""}`} contentEditable={false} onPointerDown={noFocus} onTouchStart={leaveText} onMouseDown={noFocus}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (setPlaying(false), setOpen(false), setAt(0))}
      />
      <button type="button" className="audio-pill-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "⏸" : "▶"}
      </button>
      <span className="audio-pill-icon" aria-hidden>{icon}</span>
      <span className="audio-pill-track" aria-hidden={!open}>
        <input
          type="range"
          min={0}
          max={length || 1}
          step={0.1}
          value={at}
          aria-label="Position"
          onChange={(e) => {
            if (audio.current) audio.current.currentTime = Number(e.target.value);
          }}
          style={{ "--done": `${length ? (at / length) * 100 : 0}%` } as React.CSSProperties}
        />
      </span>
      <span className="audio-pill-time">{open ? `${time(at)} / ${time(length)}` : time(length)}</span>
    </span>
  );
}

/** A video in a note: tap plays or pauses it, without focusing the text or scrolling the page. */
export function TapVideo({ src }: { src: string }) {
  return (
    <span className="tap-video" contentEditable={false}>
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        onPointerDown={(e) => {
          holdScroll();
          e.stopPropagation();
          leaveText();
        }}
        onTouchStart={leaveText}
        onPlay={() => (holdScroll(), leaveText())}
      />
    </span>
  );
}

/**
 * Double-tap a clip: it opens big in a glass card that springs out of it ("Look Up"-style), over a
 * blurred backdrop, with an arrow pointing back at it. Tap outside and it shrinks back into place.
 */
export function PeekOnDoubleTap({ children, peek }: { children: ReactNode; peek: () => ReactNode }) {
  const host = useRef<HTMLSpanElement>(null);
  const [from, setFrom] = useState<DOMRect | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!from) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const close = () => {
    setClosing(true);
    window.setTimeout(() => (setFrom(null), setClosing(false)), 220);
  };
  // About 1.5x the clip, never wider than the screen, centred on it.
  const width = from ? Math.min(window.innerWidth - 24, Math.max(from.width * 1.5, 160)) : 0;
  const height = from ? (from.height / Math.max(from.width, 1)) * width : 0;
  const screenH = window.visualViewport?.height ?? window.innerHeight;
  const below = from ? from.bottom + height + 24 < screenH : true;
  const top = from ? Math.max(12, below ? from.bottom + 12 : from.top - height - 12) : 0;
  const left = from ? Math.max(12, Math.min(window.innerWidth - width - 12, from.left + from.width / 2 - width / 2)) : 0;
  return (
    <span
      ref={host}
      className="peek-host"
      contentEditable={false}
      onPointerDown={(e) => (e.stopPropagation(), leaveText())}
      onDoubleClick={(e) => {
        noFocus(e);
        setFrom(host.current!.getBoundingClientRect());
      }}
    >
      {children}
      {from &&
        createPortal(
          <div className={`peek-layer${closing ? " closing" : ""}`} onPointerDown={(e) => (e.preventDefault(), close())}>
            <div
              className="peek-card"
              style={{
                top,
                left,
                width,
                transformOrigin: `${from.left + from.width / 2 - left}px ${from.top + from.height / 2 - top}px`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className={`peek-arrow ${below ? "up" : "down"}`} style={{ left: Math.max(16, Math.min(width - 16, from.left + from.width / 2 - left)) }} />
              {peek()}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

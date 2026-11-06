import { useEffect, type RefObject } from "react";
import { atRest, REST_EVENT } from "../lib/power";

/**
 * Plays a looping clip only while it's on screen (a note full of memes shouldn't keep the phone
 * busy), and stops it once the app is at rest (no touch for a few seconds: lib/power.ts); the next
 * touch starts it again where it was.
 */
export function usePlayWhenVisible(video: RefObject<HTMLVideoElement | null>, deps: unknown[] = []) {
  useEffect(() => {
    const v = video.current;
    if (!v || typeof IntersectionObserver === "undefined") return;
    let shown = false;
    const apply = () => {
      if (shown && !atRest()) void v.play().catch(() => {});
      else if (v.muted || v.loop) v.pause();
    };
    const seen = new IntersectionObserver(([entry]) => {
      shown = entry.isIntersecting;
      apply();
    });
    seen.observe(v.parentElement ?? v);
    window.addEventListener(REST_EVENT, apply);
    return () => {
      seen.disconnect();
      window.removeEventListener(REST_EVENT, apply);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
